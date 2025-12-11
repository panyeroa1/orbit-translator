/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import ControlTray from './components/console/control-tray/ControlTray';
import ErrorScreen from './components/demo/ErrorScreen';
import StreamingConsole from './components/demo/streaming-console/StreamingConsole';

import Header from './components/Header';
import Sidebar from './components/Sidebar';
import { LiveAPIProvider } from './contexts/LiveAPIContext';
import DatabaseBridge from './components/DatabaseBridge';
import { useUI } from './lib/state';

// Per instructions, use process.env.API_KEY directly.
const API_KEY = process.env.API_KEY as string;

// Optional: Handle missing key gracefully if possible, or throw as before.
if (typeof API_KEY !== 'string') {
  console.warn('Missing process.env.API_KEY. The app may fail to connect.');
}

/**
 * Main application component that provides a streaming interface for Live API.
 * Manages video streaming state and provides controls for webcam/screen capture.
 */
function App() {
  const { theme } = useUI();
  
  return (
    <div className="App" data-theme={theme}>
      <LiveAPIProvider apiKey={API_KEY}>
        <DatabaseBridge />
        <ErrorScreen />
        <Header />
        <Sidebar />
        <div className="streaming-console">
          <main>
            <div className="main-app-area">
              <StreamingConsole />

            </div>

            <ControlTray></ControlTray>
          </main>
        </div>
      </LiveAPIProvider>
    </div>
  );
}

export default App;