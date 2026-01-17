import {getAgentState, forceAgentState, stopAgent} from './repo-devtree-agent.js';
import {showInfoToast} from '../modules/toast.js';

let globalOwner = null;
let globalRepo = null;
let controlPanelVisible = false;

export function initDevControls(owner, repo) {
  globalOwner = owner;
  globalRepo = repo;
  setupKeyboardShortcut();
}

function setupKeyboardShortcut() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+D or Cmd+Shift+D
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      toggleControlPanel();
    }
  });
}

function toggleControlPanel() {
  if (controlPanelVisible) {
    hideControlPanel();
  } else {
    showControlPanel();
  }
}

function showControlPanel() {
  const existingPanel = document.getElementById('dev-control-panel');
  if (existingPanel) {
    existingPanel.remove();
  }

  const panel = document.createElement('div');
  panel.id = 'dev-control-panel';
  panel.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.95);
    border: 2px solid #a78bfa;
    border-radius: 8px;
    padding: 20px;
    z-index: 10000;
    min-width: 400px;
    max-width: 500px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(10px);
  `;

  const agent = getAgentState();

  panel.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="margin: 0; color: #a78bfa; font-size: 18px;">
        <i class="code icon"></i> Developer Controls
      </h3>
      <button id="close-dev-panel" style="background: none; border: none; color: rgba(255, 255, 255, 0.6); font-size: 24px; cursor: pointer; padding: 0; width: 24px; height: 24px;">&times;</button>
    </div>

    <div style="background: rgba(167, 139, 250, 0.1); border: 1px solid rgba(167, 139, 250, 0.3); padding: 12px; border-radius: 4px; margin-bottom: 16px;">
      <div style="font-size: 11px; color: rgba(255, 255, 255, 0.5); margin-bottom: 8px;">KEYBOARD SHORTCUT</div>
      <div style="color: #a78bfa; font-weight: 600;">Ctrl+Shift+D <span style="color: rgba(255, 255, 255, 0.5);">(or Cmd+Shift+D on Mac)</span></div>
    </div>

    ${agent ? `
      <div style="background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); padding: 12px; border-radius: 4px; margin-bottom: 16px;">
        <div style="font-size: 11px; color: rgba(255, 255, 255, 0.5); margin-bottom: 8px;">AGENT STATUS</div>
        <div style="color: #4ade80; font-weight: 600; margin-bottom: 4px;">State: ${agent.state || 'unknown'}</div>
        <div style="color: rgba(255, 255, 255, 0.8); font-size: 13px;">Progress: ${Math.round(agent.progress)}%</div>
        <div style="color: rgba(255, 255, 255, 0.8); font-size: 13px;">Issue: #${agent.issueId} - ${agent.issueTitle}</div>
        <div style="color: rgba(255, 255, 255, 0.8); font-size: 13px;">Commits: ${agent.commits.length}</div>
      </div>

      <div style="margin-bottom: 16px;">
        <div style="font-size: 11px; color: rgba(255, 255, 255, 0.5); margin-bottom: 8px; text-transform: uppercase;">Force Agent State</div>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
          <button class="dev-state-btn" data-state="analyzing" style="padding: 8px 12px; background: rgba(96, 165, 250, 0.2); border: 1px solid rgba(96, 165, 250, 0.5); color: #60a5fa; cursor: pointer; border-radius: 4px; font-size: 12px; transition: all 0.2s;">
            Analyzing
          </button>
          <button class="dev-state-btn" data-state="coding" style="padding: 8px 12px; background: rgba(167, 139, 250, 0.2); border: 1px solid rgba(167, 139, 250, 0.5); color: #a78bfa; cursor: pointer; border-radius: 4px; font-size: 12px; transition: all 0.2s;">
            Coding
          </button>
          <button class="dev-state-btn" data-state="testing" style="padding: 8px 12px; background: rgba(251, 191, 36, 0.2); border: 1px solid rgba(251, 191, 36, 0.5); color: #fbbf24; cursor: pointer; border-radius: 4px; font-size: 12px; transition: all 0.2s;">
            Testing
          </button>
          <button class="dev-state-btn" data-state="creating-pr" style="padding: 8px 12px; background: rgba(52, 211, 153, 0.2); border: 1px solid rgba(52, 211, 153, 0.5); color: #34d399; cursor: pointer; border-radius: 4px; font-size: 12px; transition: all 0.2s;">
            Creating PR
          </button>
          <button class="dev-state-btn" data-state="completed" style="padding: 8px 12px; background: rgba(34, 197, 94, 0.2); border: 1px solid rgba(34, 197, 94, 0.5); color: #22c55e; cursor: pointer; border-radius: 4px; font-size: 12px; transition: all 0.2s;">
            Completed
          </button>
          <button class="dev-state-btn" data-state="error" style="padding: 8px 12px; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.5); color: #ef4444; cursor: pointer; border-radius: 4px; font-size: 12px; transition: all 0.2s;">
            Error
          </button>
        </div>
      </div>

      <div style="margin-bottom: 16px;">
        <div style="font-size: 11px; color: rgba(255, 255, 255, 0.5); margin-bottom: 8px; text-transform: uppercase;">Manual Progress Control</div>
        <input type="range" id="dev-progress-slider" min="0" max="100" value="${Math.round(agent.progress)}" style="width: 100%; margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between; font-size: 12px; color: rgba(255, 255, 255, 0.6);">
          <span>0%</span>
          <span id="dev-progress-value">${Math.round(agent.progress)}%</span>
          <span>100%</span>
        </div>
      </div>

      <button id="dev-stop-agent" style="width: 100%; padding: 10px; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.5); color: #ef4444; cursor: pointer; border-radius: 4px; font-weight: 600; transition: all 0.2s;">
        <i class="stop icon"></i> Stop Agent
      </button>
    ` : `
      <div style="background: rgba(156, 163, 175, 0.1); border: 1px solid rgba(156, 163, 175, 0.3); padding: 20px; border-radius: 4px; text-align: center;">
        <div style="color: rgba(255, 255, 255, 0.5); margin-bottom: 8px;">
          <i class="info circle icon" style="font-size: 24px;"></i>
        </div>
        <div style="color: rgba(255, 255, 255, 0.7);">No agent is currently running</div>
        <div style="color: rgba(255, 255, 255, 0.5); font-size: 12px; margin-top: 8px;">Deploy an agent from the FAB menu to enable controls</div>
      </div>
    `}

    <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.1);">
      <div style="font-size: 11px; color: rgba(255, 255, 255, 0.4); text-align: center;">
        Dev Tree Agent System - Developer Mode
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  controlPanelVisible = true;

  // Event listeners
  document.getElementById('close-dev-panel').addEventListener('click', hideControlPanel);

  if (agent) {
    // State buttons
    document.querySelectorAll('.dev-state-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const state = e.currentTarget.getAttribute('data-state');
        forceAgentState(state);
        showInfoToast(`Forced agent to ${state} state`);
        // Refresh panel
        setTimeout(() => {
          if (controlPanelVisible) {
            hideControlPanel();
            showControlPanel();
          }
        }, 100);
      });

      btn.addEventListener('mouseenter', (e) => {
        e.currentTarget.style.transform = 'scale(1.05)';
        e.currentTarget.style.filter = 'brightness(1.2)';
      });

      btn.addEventListener('mouseleave', (e) => {
        e.currentTarget.style.transform = 'scale(1)';
        e.currentTarget.style.filter = 'brightness(1)';
      });
    });

    // Progress slider
    const slider = document.getElementById('dev-progress-slider');
    const progressValue = document.getElementById('dev-progress-value');

    if (slider) {
      slider.addEventListener('input', (e) => {
        const progress = parseInt(e.target.value);
        progressValue.textContent = `${progress}%`;
      });

      slider.addEventListener('change', (e) => {
        const progress = parseInt(e.target.value);
        forceAgentState(agent.state, progress);
        showInfoToast(`Set progress to ${progress}%`);
      });
    }

    // Stop button
    const stopBtn = document.getElementById('dev-stop-agent');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        stopAgent();
        hideControlPanel();
      });

      stopBtn.addEventListener('mouseenter', (e) => {
        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.3)';
      });

      stopBtn.addEventListener('mouseleave', (e) => {
        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)';
      });
    }
  }

  // Close on Escape
  const escapeHandler = (e) => {
    if (e.key === 'Escape') {
      hideControlPanel();
      document.removeEventListener('keydown', escapeHandler);
    }
  };
  document.addEventListener('keydown', escapeHandler);

  // Close on outside click
  panel.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.addEventListener('click', hideControlPanel, {once: true});
}

function hideControlPanel() {
  const panel = document.getElementById('dev-control-panel');
  if (panel) {
    panel.remove();
  }
  controlPanelVisible = false;
}
