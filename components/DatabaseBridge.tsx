/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useEffect, useRef } from 'react';
import { supabase, Transcript } from '../lib/supabase';
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

    // The consumer loop that processes the queue sequentially (AUDIO ONLY)
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

          // NOTE: We do NOT addTurn here anymore. UI is handled in processNewData.
          // This loop is purely for feeding audio to the model.

          // Send to Gemini Live to read
          // client.send() is void but safe due to check above
          client.send([{ text: scriptedText }]);

          // Remove the item we just sent
          queueRef.current.shift();

          // Dynamic delay calculation for human-like pacing
          // Reduced delays slightly to ensure "continuous" reading per user request
          const wordCount = rawText.split(/\s+/).length;
          const readTime = (wordCount / 2.8) * 1000; // Speed up slightly
          
          // Buffer calculation based on style
          let bufferBase = 2000; // Reduced default buffer
          if (style === 'natural') bufferBase = 1000;
          if (style === 'dramatic') bufferBase = 5000;

          const bufferTime = bufferBase + (Math.random() * 1000); 
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

    const processNewData = (data: Transcript) => {
      // In the new table, we only have full_transcript_text (source).
      // We rely on Gemini to translate it based on system prompt.
      const source = data.full_transcript_text;

      if (!data || !source) return;

      if (lastProcessedIdRef.current === data.id) {
        return;
      }

      lastProcessedIdRef.current = data.id;
      
      // 1. Instantly Update UI
      // Since we don't have a translation yet, we display the source in both fields
      // or just rely on the script view to show what's being processed.
      addTurn({
        role: 'system',
        text: source, 
        sourceText: source, 
        isFinal: true
      });

      // 2. Queue for Audio Processing (segments)
      // Gemini will receive this text and translate it aloud.
      const segments = segmentText(source);
      
      if (segments.length > 0) {
        queueRef.current.push(...segments);
        processQueueLoop();
      }
    };

    const fetchLatest = async () => {
      const { data, error } = await supabase
        .from('transcripts')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();
      
      if (!error && data) {
        processNewData(data as Transcript);
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
        { event: '*', schema: 'public', table: 'transcripts' },
        (payload) => {
          if (payload.new) {
             processNewData(payload.new as Transcript);
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
