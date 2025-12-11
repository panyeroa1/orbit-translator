/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://bridhpobwsfttwalwhih.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fc4iX_EGxN1Pzc4Py_SOog_8KJyvdQU';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export interface Transcript {
  id: string;
  session_id: string;
  user_id: string;
  source_language: string;
  full_transcript_text: string;
  created_at: string;
  updated_at: string;
}
