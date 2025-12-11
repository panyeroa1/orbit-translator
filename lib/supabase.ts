/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://bridhpobwsfttwalwhih.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fc4iX_EGxN1Pzc4Py_SOog_8KJyvdQU';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export interface EburonTTSCurrent {
  id: string;
  client_id: string | null;
  source_text: string;
  source_lang_code: string | null;
  source_lang_label: string | null;
  translated_text: string | null;
  target_language: string | null;
  updated_at: string;
}
