
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useUI } from '@/lib/state';
import cn from 'classnames';

export default function Header() {
  const { toggleSidebar, theme, toggleTheme } = useUI();

  return (
    <header>
      <div className="header-left">
        <h1 className="header-logo-text">
          Zoomie
          <span className="accent-dot">.</span>
        </h1>
      </div>
      <div className="header-right">
        <button 
          className="theme-button" 
          onClick={toggleTheme}
          aria-label="Toggle Theme"
        >
          <span 
            className="icon header-icon" 
            style={{ color: theme === 'dark' ? '#FDB813' : 'var(--Blue-800)' }}
          >
            {theme === 'dark' ? 'light_mode' : 'dark_mode'}
          </span>
        </button>
        <button
          className="settings-button"
          onClick={toggleSidebar}
          aria-label="Settings"
        >
          <span className="icon header-icon settings-icon">settings</span>
        </button>
      </div>
    </header>
  );
}
