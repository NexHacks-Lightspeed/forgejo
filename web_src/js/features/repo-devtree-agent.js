import {GET, POST} from '../modules/fetch.js';
import {showErrorToast, showInfoToast} from '../modules/toast.js';
import $ from 'jquery';

let globalOwner = null;
let globalRepo = null;
let selectedCommitSHA = null;
let currentAgent = null;

// Agent state configuration
const AGENT_STATES = {
  ANALYZING: {
    name: 'analyzing',
    message: 'Analyzing requirements...',
    duration: [10000, 30000], // 10-30 seconds
    progress: [0, 20],
  },
  CODING: {
    name: 'coding',
    message: 'Implementing feature...',
    duration: [30000, 120000], // 30-120 seconds
    progress: [20, 70],
    commits: [2, 5], // Generate 2-5 mock commits
  },
  TESTING: {
    name: 'testing',
    message: 'Running tests...',
    duration: [10000, 20000],
    progress: [70, 90],
  },
  CREATING_PR: {
    name: 'creating-pr',
    message: 'Creating pull request...',
    duration: [5000, 10000],
    progress: [90, 100],
  },
  COMPLETED: {
    name: 'completed',
    message: 'Completed',
    progress: [100, 100],
  },
  ERROR: {
    name: 'error',
    message: 'Error occurred',
    progress: [0, 0],
  },
};

// Speed multipliers
const SPEED_MULTIPLIERS = {
  fast: 0.1,
  normal: 1.0,
  slow: 2.0,
};

// Mock commit templates
const COMMIT_TEMPLATES = [
  'Implement {feature} functionality',
  'Add {feature} module',
  'Refactor {feature} for better performance',
  'Fix {feature} bug',
  'Update {feature} tests',
];

const EXPLANATION_TEMPLATES = [
  'This commit implements the core logic for {feature}. The approach uses modern patterns and best practices to ensure maintainability.',
  'Added a new module to handle {feature} operations. Key features include proper error handling and comprehensive test coverage.',
  'Refactored the {feature} component to improve code readability and reduce complexity. This makes future maintenance easier.',
  'Fixed a critical bug in {feature} that was causing unexpected behavior. Added regression tests to prevent similar issues.',
  'Updated test coverage for {feature} to ensure reliability and catch edge cases early in development.',
];

export function initDevTreeAgent(owner, repo) {
  globalOwner = owner;
  globalRepo = repo;

  // FAB removed - create issue button is now in commit detail panel
  setupModals();
}

export function setSelectedCommit(sha) {
  selectedCommitSHA = sha;
}

function setupFAB() {
  const fabButton = document.getElementById('fab-main-button');
  const fabMenu = document.querySelector('.fab-menu');

  if (!fabButton || !fabMenu) return;

  // Toggle FAB menu
  fabButton.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = fabMenu.style.display !== 'none';
    fabMenu.style.display = isVisible ? 'none' : 'block';
  });

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.devtree-fab')) {
      fabMenu.style.display = 'none';
    }
  });

  // Handle menu item clicks
  document.querySelectorAll('.fab-menu-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      const action = e.currentTarget.getAttribute('data-action');
      fabMenu.style.display = 'none';

      if (action === 'create-issue') {
        openCreateIssueModal();
      } else if (action === 'deploy-agent') {
        openDeployAgentModal();
      }
    });
  });
}

function setupModals() {
  // Handle cancel button for create issue modal
  const createIssueModalElement = document.getElementById('create-issue-modal');
  if (createIssueModalElement) {
    const cancelBtn = createIssueModalElement.querySelector('.cancel.button');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        closeCreateIssueModal();
      });
    }

    // Listen for successful form submission
    const form = document.getElementById('create-issue-form');
    if (form) {
      form.addEventListener('submit', () => {
        // Close modal after a short delay to allow form-fetch-action to process
        setTimeout(() => {
          closeCreateIssueModal();
        }, 100);
      });
    }
  }

  // Deploy Agent Modal
  const deployAgentModal = $('#deploy-agent-modal');
  const deployAgentSubmit = document.getElementById('deploy-agent-submit');

  if (deployAgentSubmit) {
    deployAgentSubmit.addEventListener('click', async () => {
      await handleDeployAgent();
    });
  }
}

export async function openCreateIssueModal() {
  if (!selectedCommitSHA) {
    showErrorToast('Please select a commit from the graph first');
    return;
  }

  // Set the base SHA display
  const baseShaInput = document.getElementById('issue-base-sha');
  if (baseShaInput) {
    baseShaInput.value = selectedCommitSHA;
  }

  // Pre-fill the content with commit reference
  const contentTextarea = document.querySelector('#create-issue-form textarea[name="content"]');
  if (contentTextarea && selectedCommitSHA) {
    contentTextarea.value = `\n\n---\nBase commit: \`${selectedCommitSHA}\``;
  }

  // Show modal using custom implementation (avoid Semantic UI modal issues)
  const modal = document.getElementById('create-issue-modal');
  if (!modal) {
    showErrorToast('Modal not found');
    return;
  }

  // CRITICAL: Hide commit detail panel overlay to prevent blocking
  const commitOverlay = document.getElementById('commit-detail-overlay');
  if (commitOverlay) {
    commitOverlay.style.zIndex = '-1';
    commitOverlay.style.pointerEvents = 'none';
  }

  // Remove any existing dimmer or Semantic UI dimmers
  const existingDimmer = document.getElementById('create-issue-dimmer');
  if (existingDimmer) existingDimmer.remove();

  // Remove any Semantic UI auto-generated dimmers
  document.querySelectorAll('.ui.dimmer.modals').forEach((d) => d.remove());

  // Create our own dimmer with maximum z-index
  const dimmer = document.createElement('div');
  dimmer.id = 'create-issue-dimmer';
  dimmer.style.cssText = `
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100% !important;
    height: 100% !important;
    background: rgba(0, 0, 0, 0.85) !important;
    z-index: 999999 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    pointer-events: auto !important;
  `;
  dimmer.onclick = (e) => {
    if (e.target === dimmer) {
      closeCreateIssueModal();
    }
  };

  // Show modal with maximum z-index and ensure it's clickable
  modal.style.cssText = `
    display: block !important;
    position: fixed !important;
    z-index: 1000000 !important;
    top: 50% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) !important;
    margin: 0 !important;
    pointer-events: auto !important;
    max-height: 90vh !important;
    overflow-y: auto !important;
  `;

  // Append to body root, not inside anything else
  document.body.appendChild(dimmer);
  dimmer.appendChild(modal);

  // Log for debugging
  console.log('Modal opened - z-index:', modal.style.zIndex, 'Dimmer z-index:', dimmer.style.zIndex);
}

function closeCreateIssueModal() {
  const modal = document.getElementById('create-issue-modal');
  const dimmer = document.getElementById('create-issue-dimmer');

  // Move modal back to body root before removing dimmer
  if (modal && dimmer && modal.parentElement === dimmer) {
    document.body.appendChild(modal);
  }

  // Remove dimmer
  if (dimmer) {
    dimmer.remove();
  }

  // Remove any Semantic UI auto-generated dimmers
  document.querySelectorAll('.ui.dimmer.modals').forEach(d => d.remove());

  // Hide modal and reset its styles
  if (modal) {
    modal.style.cssText = '';
    modal.classList.remove('visible', 'active');
  }

  // CRITICAL: Restore commit detail panel overlay
  const commitOverlay = document.getElementById('commit-detail-overlay');
  if (commitOverlay) {
    commitOverlay.style.zIndex = '';
    commitOverlay.style.pointerEvents = '';
  }

  // Reset form
  const form = document.getElementById('create-issue-form');
  if (form) form.reset();

  console.log('Modal closed');
}

async function openDeployAgentModal() {
  if (!selectedCommitSHA) {
    showErrorToast('Please select a commit from the graph first');
    return;
  }

  // Set the base SHA
  document.getElementById('agent-base-sha').value = selectedCommitSHA;

  // Load open issues
  await loadOpenIssues();

  // Initialize dropdowns
  $('#agent-issue').dropdown();
  $('#agent-speed').dropdown();

  // Show modal
  $('#deploy-agent-modal').modal('show');
}

async function loadOpenIssues() {
  try {
    const response = await GET(`/api/v1/repos/${globalOwner}/${globalRepo}/issues?state=open&type=issues`);
    const issues = await response.json();

    const dropdown = $('#agent-issue');
    const menu = dropdown.find('.menu');
    menu.empty();

    if (issues.length === 0) {
      menu.append('<div class="item disabled">No open issues</div>');
    } else {
      issues.forEach((issue) => {
        menu.append(`<div class="item" data-value="${issue.number}">#${issue.number} - ${issue.title}</div>`);
      });
    }

    dropdown.dropdown();
  } catch (error) {
    console.error('Failed to load issues:', error);
    showErrorToast('Failed to load open issues');
  }
}

async function handleDeployAgent() {
  const issueId = $('#agent-issue').dropdown('get value');
  const baseSha = document.getElementById('agent-base-sha').value;
  const speed = $('#agent-speed').dropdown('get value') || 'normal';

  if (!issueId) {
    showErrorToast('Please select an issue');
    return;
  }

  if (!baseSha) {
    showErrorToast('Base commit SHA is required');
    return;
  }

  // Get issue details for title
  let issueTitle = 'Unknown Issue';
  try {
    const response = await GET(`/api/v1/repos/${globalOwner}/${globalRepo}/issues/${issueId}`);
    const issue = await response.json();
    issueTitle = issue.title;
  } catch (error) {
    console.error('Failed to get issue details:', error);
  }

  $('#deploy-agent-modal').modal('hide');

  // Start agent simulation
  startAgentSimulation(issueId, issueTitle, baseSha, speed);
}

function startAgentSimulation(issueId, issueTitle, baseSha, speed) {
  if (currentAgent) {
    showErrorToast('An agent is already running. Please wait for it to complete.');
    return;
  }

  const speedMultiplier = SPEED_MULTIPLIERS[speed] || 1.0;

  currentAgent = {
    issueId,
    issueTitle,
    baseSha,
    speed: speedMultiplier,
    state: null,
    progress: 0,
    commits: [],
    timers: [],
  };

  showInfoToast(`Agent deployed for issue #${issueId}`);
  transitionToState(AGENT_STATES.ANALYZING);
}

function transitionToState(state) {
  if (!currentAgent) return;

  currentAgent.state = state.name;
  const [minProgress, maxProgress] = state.progress;
  currentAgent.progress = minProgress;

  updateStatusBadge(state.name, minProgress, state.message);

  if (state.name === 'completed') {
    handleAgentCompleted();
    return;
  }

  if (state.name === 'error') {
    handleAgentError('Simulation error');
    return;
  }

  // Schedule state progression
  if (state.duration) {
    const [minDuration, maxDuration] = state.duration;
    const duration = Math.random() * (maxDuration - minDuration) + minDuration;
    const scaledDuration = duration * currentAgent.speed;

    // Animate progress
    const progressIncrement = (maxProgress - minProgress) / 10;
    const progressInterval = scaledDuration / 10;

    const progressTimer = setInterval(() => {
      if (!currentAgent || currentAgent.state !== state.name) {
        clearInterval(progressTimer);
        return;
      }

      currentAgent.progress = Math.min(currentAgent.progress + progressIncrement, maxProgress);
      updateStatusBadge(state.name, currentAgent.progress, state.message);
    }, progressInterval);

    currentAgent.timers.push(progressTimer);

    // Handle special state logic
    if (state.name === 'coding') {
      const numCommits = Math.floor(Math.random() * (state.commits[1] - state.commits[0] + 1)) + state.commits[0];
      const commitInterval = scaledDuration / numCommits;

      let commitCount = 0;
      const commitTimer = setInterval(() => {
        if (!currentAgent || currentAgent.state !== state.name) {
          clearInterval(commitTimer);
          return;
        }

        if (commitCount < numCommits) {
          generateAndDisplayMockCommit();
          commitCount++;
        } else {
          clearInterval(commitTimer);
        }
      }, commitInterval);

      currentAgent.timers.push(commitTimer);
    }

    // Schedule next state transition
    const stateTimer = setTimeout(() => {
      if (!currentAgent) return;

      if (state.name === 'analyzing') {
        transitionToState(AGENT_STATES.CODING);
      } else if (state.name === 'coding') {
        transitionToState(AGENT_STATES.TESTING);
      } else if (state.name === 'testing') {
        transitionToState(AGENT_STATES.CREATING_PR);
      } else if (state.name === 'creating-pr') {
        createPullRequest();
      }
    }, scaledDuration);

    currentAgent.timers.push(stateTimer);
  }
}

function generateAndDisplayMockCommit() {
  const feature = currentAgent.issueTitle.substring(0, 30);
  const template = COMMIT_TEMPLATES[Math.floor(Math.random() * COMMIT_TEMPLATES.length)];
  const explanationTemplate = EXPLANATION_TEMPLATES[Math.floor(Math.random() * EXPLANATION_TEMPLATES.length)];

  const message = template.replace('{feature}', feature);
  const explanation = explanationTemplate.replace('{feature}', feature);

  const mockCommit = {
    sha: `mock-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    short_sha: `mock-${Math.random().toString(36).substr(2, 7)}`,
    message,
    explanation,
    author: {
      name: 'Coding Agent',
      email: 'agent@devtree.local',
      date: new Date().toISOString(),
    },
    committer: {
      name: 'Coding Agent',
      email: 'agent@devtree.local',
      date: new Date().toISOString(),
    },
  };

  currentAgent.commits.push(mockCommit);
  showInfoToast(`Agent committed: ${message.substring(0, 50)}...`);

  // Visually update graph (this would trigger a graph refresh in a real implementation)
  console.log('Mock commit generated:', mockCommit);
}

async function createPullRequest() {
  updateStatusBadge('creating-pr', 95, 'Creating pull request...');

  const prData = {
    title: `Fix: ${currentAgent.issueTitle}`,
    body: `This PR addresses issue #${currentAgent.issueId}\n\n## Changes\nThis PR was automatically created by the Dev Tree coding agent.\n\n### Commits\n${currentAgent.commits.map((c) => `- ${c.message}`).join('\n')}\n\n## Testing\nAll tests have been run and pass successfully.`,
    head: `agent-issue-${currentAgent.issueId}-${Date.now()}`,
    base: 'main',
  };

  try {
    // In a real implementation, this would create an actual PR
    // For simulation, we just show success
    console.log('Would create PR:', prData);

    setTimeout(() => {
      showInfoToast(`Pull request created for issue #${currentAgent.issueId}`);
      transitionToState(AGENT_STATES.COMPLETED);
    }, 2000 * currentAgent.speed);
  } catch (error) {
    console.error('Error creating PR:', error);
    handleAgentError(error.message);
  }
}

function handleAgentCompleted() {
  updateStatusBadge('completed', 100, 'Completed successfully');

  setTimeout(() => {
    hideStatusBadge();
    cleanupAgent();
  }, 5000);
}

function handleAgentError(message) {
  updateStatusBadge('error', 0, `Error: ${message}`);
  showErrorToast(`Agent error: ${message}`);

  setTimeout(() => {
    hideStatusBadge();
    cleanupAgent();
  }, 5000);
}

function cleanupAgent() {
  if (!currentAgent) return;

  // Clear all timers
  currentAgent.timers.forEach((timer) => {
    if (typeof timer === 'number') {
      clearTimeout(timer);
      clearInterval(timer);
    }
  });

  currentAgent = null;
}

function updateStatusBadge(status, progress, message) {
  const badge = document.getElementById('agent-status-badge');
  if (!badge) return;

  badge.style.display = 'flex';
  badge.className = `agent-status-badge status-${status}`;

  const statusText = badge.querySelector('.status-text');
  if (statusText) {
    statusText.textContent = message;
  }

  const progressFill = badge.querySelector('.progress-bar-fill');
  if (progressFill) {
    progressFill.style.width = `${progress}%`;
  }
}

function hideStatusBadge() {
  const badge = document.getElementById('agent-status-badge');
  if (badge) {
    badge.style.display = 'none';
  }
}

// Export for dev controls
export function getAgentState() {
  return currentAgent;
}

export function forceAgentState(state, progress) {
  if (!currentAgent) {
    showErrorToast('No agent is currently running');
    return;
  }

  // Clear existing timers
  currentAgent.timers.forEach((timer) => {
    clearTimeout(timer);
    clearInterval(timer);
  });
  currentAgent.timers = [];

  // Force to new state
  const stateConfig = Object.values(AGENT_STATES).find((s) => s.name === state);
  if (stateConfig) {
    if (progress !== undefined) {
      currentAgent.progress = progress;
      updateStatusBadge(state, progress, stateConfig.message);
    } else {
      transitionToState(stateConfig);
    }
  }
}

export function stopAgent() {
  if (currentAgent) {
    cleanupAgent();
    hideStatusBadge();
    showInfoToast('Agent stopped');
  }
}
