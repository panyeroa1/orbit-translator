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

// Helper to segment text into natural reading chunks (Paragraphs)
// The source data in Supabase is updated per paragraph, so we preserve that structure.
const segmentText = (text: string): string[] => {
  if (!text) return [];
  // Split by newlines (paragraph breaks) to define render tasks
  // This ensures the model receives and renders the content paragraph by paragraph
  return text.split(/\r?\n+/).map(t => t.trim()).filter(t => t.length > 0);
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
          // Since we are processing paragraphs, we add pauses between them for natural flow
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
          // Adjusted for paragraph-level reading
          const wordCount = rawText.split(/\s+/).length;
          // Estimate reading time: avg speaking rate ~150 wpm -> 2.5 words/sec -> ~400ms per word
          // We assume the model speaks, so we just need a small buffer before sending the next paragraph
          // The model has an internal queue, but we throttle inputs slightly to avoid overwhelming context
          const readTime = (wordCount / 3.0) * 1000; 
          
          // Buffer calculation based on style
          let bufferBase = 1500; 
          if (style === 'natural') bufferBase = 1000;
          if (style === 'dramatic') bufferBase = 3000;

          const bufferTime = bufferBase; 
          
          // For paragraphs, we can wait a bit less than the full read time because 
          // we want the model to chain them, but we don't want to stack 10 paragraphs instantly.
          const totalDelay = Math.min(5000, readTime * 0.5) + bufferTime;
          
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
      // Display the full source text in the script view
      addTurn({
        role: 'system',
        text: source, 
        sourceText: source, 
        isFinal: true
      });

      // 2. Queue for Audio Processing (Paragraph segments)
      // Gemini will receive this text and translate/read it aloud paragraph by paragraph.
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
    // Event listener for DB changes that triggers the prompt generation function
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