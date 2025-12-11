/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useEffect, useRef } from 'react';
import { supabase, EburonTTSCurrent } from '../lib/supabase';
import { useLiveAPIContext } from '../contexts/LiveAPIContext';
import { useLogStore, useSettings } from '../lib/state';

// Worker script to ensure polling continues even when tab is in background
const workerScript = `
  self.onmessage = function() {
    setInterval(() => {
      self.postMessage('tick');
    }, 5000);
  };
`;

// Helper to segment text into natural reading chunks (2-3 sentences)
const segmentText = (text: string): string[] => {
  if (!text) return [];

  let sentences: string[] = [];

  // Robust segmentation using Intl.Segmenter
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    try {
      // @ts-ignore - Intl.Segmenter might not be in all TS definitions yet
      const segmenter = new (Intl as any).Segmenter('en', { granularity: 'sentence' });
      // @ts-ignore
      sentences = Array.from(segmenter.segment(text)).map((s: any) => s.segment);
    } catch (e) {
      sentences = text.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [text];
    }
  } else {
     sentences = text.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [text];
  }
  
  const chunks: string[] = [];
  let currentChunk = '';
  let sentenceCount = 0;

  for (const sentence of sentences) {
    const cleanSentence = sentence.trim();
    if (!cleanSentence) continue;
    
    // Add space if appending to existing chunk
    if (currentChunk) currentChunk += ' ';
    currentChunk += cleanSentence;
    sentenceCount++;
    
    // Chunking heuristics
    if ((sentenceCount >= 2 && currentChunk.length > 150) || sentenceCount >= 3 || currentChunk.length > 250) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
      sentenceCount = 0;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
};

export default function DatabaseBridge() {
  const { client, connected } = useLiveAPIContext();
  const { addTurn } = useLogStore();
  const { voiceStyle } = useSettings();
  
  const lastProcessedIdRef = useRef<string | null>(null);
  
  const voiceStyleRef = useRef(voiceStyle);
  useEffect(() => {
    voiceStyleRef.current = voiceStyle;
  }, [voiceStyle]);

  // High-performance queue using Refs to handle data spikes without re-renders
  const queueRef = useRef<string[]>([]);
  const isProcessingRef = useRef(false);

  // Data Ingestion & Processing Logic
  useEffect(() => {
    // DO NOT clear queue here. We want persistence if connection flickers.
    isProcessingRef.current = false;

    if (!connected) return;

    // The consumer loop that processes the queue sequentially
    const processQueueLoop = async () => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      try {
        // While there are items
        while (queueRef.current.length > 0) {
          // Safety check: Abort processing if client disconnected mid-loop
          if (client.status !== 'connected') {
            isProcessingRef.current = false;
            return;
          }

          const rawText = queueRef.current[0];
          const style = voiceStyleRef.current;

          // Inject Stage Directions based on selected Style
          let scriptedText = rawText;
          if (style === 'breathy') {
            scriptedText = `(soft inhale) ${rawText} ... (pause)`;
          } else if (style === 'dramatic') {
             scriptedText = `(slowly) ${rawText} ... (long pause)`;
          }

          // Ensure we don't send empty strings which can break the API
          if (!scriptedText || !scriptedText.trim()) {
            queueRef.current.shift();
            continue;
          }

          // Log to console as a "Script Item"
          addTurn({
            role: 'system',
            text: scriptedText,
            isFinal: true
          });

          // Send to Gemini Live to read
          // client.send() is void but safe due to check above
          client.send([{ text: scriptedText }]);

          // Remove the item we just sent
          queueRef.current.shift();

          // Dynamic delay calculation for human-like pacing
          const wordCount = rawText.split(/\s+/).length;
          const readTime = (wordCount / 2.5) * 1000;
          
          // Buffer calculation based on style
          let bufferBase = 5000;
          if (style === 'natural') bufferBase = 2000;
          if (style === 'dramatic') bufferBase = 7000;

          const bufferTime = bufferBase + (Math.random() * 2000); 
          const totalDelay = readTime + bufferTime;
          
          // Wait before processing next chunk
          await new Promise(resolve => setTimeout(resolve, totalDelay));
        }
      } catch (e) {
        console.error('Error in processing loop:', e);
      } finally {
        isProcessingRef.current = false;
      }
    };

    // If there are pending items from before we connected, start processing immediately
    if (queueRef.current.length > 0) {
      processQueueLoop();
    }

    const processNewData = (data: EburonTTSCurrent) => {
      const textToRead = (data.translated_text && data.translated_text.trim().length > 0) 
        ? data.translated_text 
        : data.source_text;

      if (!data || !textToRead) return;

      if (lastProcessedIdRef.current === data.id) {
        return;
      }

      lastProcessedIdRef.current = data.id;
      
      const segments = segmentText(textToRead);
      
      if (segments.length > 0) {
        queueRef.current.push(...segments);
        processQueueLoop();
      }
    };

    const fetchLatest = async () => {
      const { data, error } = await supabase
        .from('eburon_tts_current')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();
      
      if (!error && data) {
        processNewData(data as EburonTTSCurrent);
      }
    };

    // 1. Initialize Web Worker for background polling
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = () => {
      fetchLatest();
    };
    worker.postMessage('start');

    // 2. Setup Realtime Subscription
    const channel = supabase
      .channel('bridge-realtime-opt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'eburon_tts_current' },
        (payload) => {
          if (payload.new) {
             processNewData(payload.new as EburonTTSCurrent);
          }
        }
      )
      .subscribe();

    // 3. Initial Fetch
    fetchLatest();

    return () => {
      worker.terminate();
      supabase.removeChannel(channel);
    };
  }, [connected, client, addTurn]);

  return null;
}
