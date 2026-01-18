import {GET, POST} from '../modules/fetch.js';
import {showErrorToast, showInfoToast} from '../modules/toast.js';
import $ from 'jquery';
import {initDevTreeAgent, setSelectedCommit, openCreateIssueModal} from './repo-devtree-agent.js';
import {initPRReview, openPRReviewPanel} from './repo-devtree-pr-review.js';
import {initDevControls} from './repo-devtree-dev-controls.js';

// Branch color palette (from gitgraph.css) - 16 colors
const BRANCH_COLORS = [
  '#95e045', '#5ec74d', '#ff5a6e', '#bfd935', '#d648d0', '#8b5fff',
  '#ff9640', '#5cffb8', '#ff8a60', '#3fa5c7', '#ff6838', '#4dd680',
  '#b840d8', '#52d68f', '#2d6fff', '#d83ca8',
];

const BRANCH_COLORS_HIGHLIGHT = [
  '#a8ff58', '#6fff60', '#ff7095', '#e5ff50', '#ff6aff', '#a070ff',
  '#ffb668', '#68ffcc', '#ffaa80', '#50c8e5', '#ff8550', '#5fff98',
  '#d858ff', '#68ffa8', '#4d8aff', '#ff50c0',
];

// Layout dimensions (Railway-style card nodes)
const COLUMN_SPACING = 300;  // Wide spacing for card nodes (increased for better branch separation)
const ROW_SPACING = 120;     // Vertical spacing for cards (increased from 70)
const CARD_WIDTH = 180;      // Card width
const CARD_HEIGHT = 60;      // Card height
const CARD_RADIUS = 8;       // Card corner radius
const COMMIT_RADIUS = 8;     // Fallback circle size
const STROKE_WIDTH = 2.5;    // Path stroke width

// Pan/zoom constants
const DEFAULT_SCALE = 1.0;
const MIN_SCALE = 0.3;
const MAX_SCALE = 3.0;
const ZOOM_SPEED = 0.08;  // Reduced from 0.15 for less sensitivity
const PAN_THRESHOLD = 5; // pixels before treating as pan vs click

// State management class
class DevTreeState {
  constructor() {
    this.scale = DEFAULT_SCALE;
    this.translateX = 0;
    this.translateY = 0;
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;
    this.startTranslateX = 0;
    this.startTranslateY = 0;
    this.panDistance = 0;
  }
}

let globalState = null;
let globalOwner = null;
let globalRepo = null;
let panZoomGroup = null;
let currentViewBox = null; // Store viewBox for reset
let globalFlows = []; // Store flows for branch name lookups
let globalCommits = []; // Store commits for lookups

export function initRepoDevTree() {
  const container = document.getElementById('devtree-container');
  if (!container) return;

  globalOwner = container.getAttribute('data-owner');
  globalRepo = container.getAttribute('data-repo');
  globalState = new DevTreeState();

  // Setup zoom controls
  setupZoomControls();

  // Load and render graph (no filters needed)
  loadCommitGraph(globalOwner, globalRepo, container);

  // Setup side panel close handlers
  setupPanelHandlers();
  setupPRDetailPanelHandlers();

  // Initialize agent features
  initDevTreeAgent(globalOwner, globalRepo);
  initPRReview(globalOwner, globalRepo);
  initDevControls(globalOwner, globalRepo);
}

async function fetchGraphData(owner, repo, page = 1) {
  const url = `/api/v1/repos/${owner}/${repo}/graph?page=${page}&limit=100`;
  const response = await GET(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

function getBranchColor(branchIndex, highlight = false) {
  const colors = highlight ? BRANCH_COLORS_HIGHLIGHT : BRANCH_COLORS;
  return colors[branchIndex % colors.length];
}

function addGridPattern(svg) {
  // Create pattern for Railway-style grid dots
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');

  pattern.setAttribute('id', 'grid-pattern');
  pattern.setAttribute('width', '24');
  pattern.setAttribute('height', '24');
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');

  // Add a small circle for the grid dot - more visible
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '1');
  circle.setAttribute('cy', '1');
  circle.setAttribute('r', '1.2');
  circle.setAttribute('fill', 'rgba(255, 255, 255, 0.25)');
  circle.setAttribute('opacity', '0.8');

  pattern.appendChild(circle);
  defs.appendChild(pattern);
  svg.appendChild(defs);
}

function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

function createCommitCard(commit, x, y, colorNum) {
  // Create group for card
  const cardGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  cardGroup.setAttribute('class', 'commit-card');
  cardGroup.setAttribute('data-sha', commit.sha);
  cardGroup.setAttribute('data-color', colorNum);

  // Detect commit type
  const isMerge = commit.parents && commit.parents.length > 1;
  const isTagged = commit.refs && commit.refs.length > 0;
  const hasIssues = commit.linked_issues && commit.linked_issues.length > 0;

  if (isMerge) cardGroup.classList.add('merge-commit');
  if (isTagged) cardGroup.classList.add('tagged-commit');
  if (hasIssues) cardGroup.classList.add('has-issues');

  // Get color for this commit
  const color = BRANCH_COLORS[colorNum % BRANCH_COLORS.length];

  // Create card rectangle with opaque background
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', x - CARD_WIDTH / 2);
  rect.setAttribute('y', y - CARD_HEIGHT / 2);
  rect.setAttribute('width', CARD_WIDTH);
  rect.setAttribute('height', CARD_HEIGHT);
  rect.setAttribute('rx', CARD_RADIUS);
  rect.setAttribute('ry', CARD_RADIUS);
  rect.setAttribute('fill', '#0f0f0f');
  rect.setAttribute('stroke', color);
  rect.setAttribute('stroke-width', '1.5');
  cardGroup.appendChild(rect);

  // Add issue indicator icon if commit has linked issues
  if (hasIssues) {
    const iconX = x - CARD_WIDTH / 2 + 8;
    const iconY = y - CARD_HEIGHT / 2 + 8;

    // Create exclamation mark icon (no background)
    const iconText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    iconText.setAttribute('x', iconX);
    iconText.setAttribute('y', iconY + 1);
    iconText.setAttribute('text-anchor', 'middle');
    iconText.setAttribute('dominant-baseline', 'middle');
    iconText.setAttribute('font-size', '14');
    iconText.setAttribute('font-weight', '900');
    iconText.setAttribute('fill', '#fb923c');
    iconText.setAttribute('class', 'issue-indicator-icon');
    iconText.textContent = '!';
    cardGroup.appendChild(iconText);

    // Add issue count badge
    if (commit.linked_issues.length > 1) {
      const badgeX = iconX + 7;
      const badgeY = iconY - 7;

      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      badge.setAttribute('cx', badgeX);
      badge.setAttribute('cy', badgeY);
      badge.setAttribute('r', '6');
      badge.setAttribute('fill', '#dc2626');
      badge.setAttribute('stroke', '#0f0f0f');
      badge.setAttribute('stroke-width', '1.5');
      cardGroup.appendChild(badge);

      const badgeText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      badgeText.setAttribute('x', badgeX);
      badgeText.setAttribute('y', badgeY + 1);
      badgeText.setAttribute('text-anchor', 'middle');
      badgeText.setAttribute('dominant-baseline', 'middle');
      badgeText.setAttribute('font-size', '8');
      badgeText.setAttribute('font-weight', '700');
      badgeText.setAttribute('fill', '#ffffff');
      badgeText.textContent = commit.linked_issues.length;
      cardGroup.appendChild(badgeText);
    }
  }

  // Add commit hash (short)
  const shortSha = commit.short_sha || commit.sha.substring(0, 7);
  const hashText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  hashText.setAttribute('x', x);
  hashText.setAttribute('y', y - CARD_HEIGHT / 2 + 18);
  hashText.setAttribute('text-anchor', 'middle');
  hashText.setAttribute('class', 'commit-card-text');
  hashText.setAttribute('fill', color);
  hashText.setAttribute('font-weight', '600');
  hashText.textContent = shortSha;
  cardGroup.appendChild(hashText);

  // Add commit message (truncated)
  const message = truncateText(commit.message || '', 22);
  const messageText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  messageText.setAttribute('x', x);
  messageText.setAttribute('y', y - CARD_HEIGHT / 2 + 35);
  messageText.setAttribute('text-anchor', 'middle');
  messageText.setAttribute('class', 'commit-card-message');
  messageText.textContent = message;
  cardGroup.appendChild(messageText);

  // Add author name (truncated)
  const authorName = truncateText(
    commit.author?.name || commit.committer?.name || 'Unknown',
    20
  );
  const authorText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  authorText.setAttribute('x', x);
  authorText.setAttribute('y', y - CARD_HEIGHT / 2 + 50);
  authorText.setAttribute('text-anchor', 'middle');
  authorText.setAttribute('class', 'commit-card-message');
  authorText.setAttribute('font-size', '9');
  authorText.setAttribute('fill', 'rgba(255, 255, 255, 0.5)');
  authorText.textContent = authorName;
  cardGroup.appendChild(authorText);

  // Add PR icon if this commit has a linked PR
  if (commit.pullRequest) {
    const pr = commit.pullRequest;
    console.log('[DevTree] Adding PR icon to commit', commit.sha.substring(0, 7), 'PR#', pr.number);
    const prIcon = createPRIcon(pr, commit);
    prIcon.setAttribute('transform', `translate(${CARD_WIDTH - 35}, ${-CARD_HEIGHT / 2 + 5})`);
    cardGroup.appendChild(prIcon);
  }

  return cardGroup;
}

// Create PR merge icon based on state - minimal, modern design
function createPRIcon(pr, commit) {
  const iconGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  iconGroup.setAttribute('class', 'pr-icon');
  iconGroup.style.cursor = 'pointer';

  // Determine color based on PR state
  let color;
  if (pr.merged) {
    color = '#8b5cf6'; // purple for merged
  } else if (pr.state === 'open') {
    color = '#22c55e'; // green for open
  } else {
    color = '#ef4444'; // red for closed
  }

  // Background circle
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '14');
  circle.setAttribute('cy', '14');
  circle.setAttribute('r', '12');
  circle.setAttribute('fill', color);
  circle.setAttribute('opacity', '0.15');
  circle.setAttribute('stroke', color);
  circle.setAttribute('stroke-width', '1.5');

  // Git merge symbol (two branches merging)
  const mergePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  // Two branches: one straight, one curved joining it
  mergePath.setAttribute('d', 'M10 8 L10 20 M18 8 Q18 14 10 16');
  mergePath.setAttribute('stroke', color);
  mergePath.setAttribute('stroke-width', '2');
  mergePath.setAttribute('stroke-linecap', 'round');
  mergePath.setAttribute('stroke-linejoin', 'round');
  mergePath.setAttribute('fill', 'none');

  // Branch points (small circles)
  const point1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  point1.setAttribute('cx', '10');
  point1.setAttribute('cy', '8');
  point1.setAttribute('r', '2.5');
  point1.setAttribute('fill', color);

  const point2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  point2.setAttribute('cx', '18');
  point2.setAttribute('cy', '8');
  point2.setAttribute('r', '2.5');
  point2.setAttribute('fill', color);

  iconGroup.appendChild(circle);
  iconGroup.appendChild(mergePath);
  iconGroup.appendChild(point1);
  iconGroup.appendChild(point2);

  // Add file count badge if available
  if (pr.changed_files > 0) {
    const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    badge.setAttribute('x', '24');
    badge.setAttribute('y', '10');
    badge.setAttribute('font-size', '9');
    badge.setAttribute('font-weight', '600');
    badge.setAttribute('fill', color);
    badge.textContent = pr.changed_files;
    iconGroup.appendChild(badge);
  }

  // Click handler to expand PR details inline
  iconGroup.addEventListener('click', (e) => {
    e.stopPropagation();
    openPRDetailPanel(pr);
  });

  return iconGroup;
}

// Open PR detail panel (slide in from right)
async function openPRDetailPanel(pr) {
  const overlay = document.getElementById('pr-detail-overlay-right');
  const panel = document.getElementById('pr-detail-panel-right');
  const content = panel.querySelector('.panel-content');

  if (!overlay || !panel || !content) {
    console.error('PR detail panel elements not found');
    return;
  }

  // Show panel and overlay
  overlay.classList.add('active');
  panel.classList.add('active');

  // Show loading
  content.innerHTML = '<div class="loading" style="text-align: center; padding: 40px; color: rgba(255, 255, 255, 0.5);">Loading PR details...</div>';

  try {
    // Fetch PR details if not already loaded
    if (!pr.detailsLoaded) {
      const response = await GET(`/api/v1/repos/${globalOwner}/${globalRepo}/pulls/${pr.number}`);
      if (response.ok) {
        const details = await response.json();
        Object.assign(pr, details);
        pr.detailsLoaded = true;
      }

      // Fetch reviews
      const reviewsResponse = await GET(`/api/v1/repos/${globalOwner}/${globalRepo}/pulls/${pr.number}/reviews`);
      if (reviewsResponse.ok) {
        pr.reviews = await reviewsResponse.json();
      }

      // Fetch comments
      const commentsResponse = await GET(`/api/v1/repos/${globalOwner}/${globalRepo}/issues/${pr.number}/comments`);
      if (commentsResponse.ok) {
        pr.comments = await commentsResponse.json();
      }

      // Fetch files (diff)
      const filesResponse = await GET(`/${globalOwner}/${globalRepo}/pulls/${pr.number}.diff`);
      if (filesResponse.ok) {
        pr.diffText = await filesResponse.text();
      }
    }

    // Render PR details with tabs
    renderPRDetailPanelWithTabs(content, pr);
  } catch (error) {
    console.error('Failed to load PR details:', error);
    content.innerHTML = `<div style="text-align: center; padding: 40px; color: #ef4444;">Failed to load PR details</div>`;
  }
}

// Close PR detail panel
function closePRDetailPanel() {
  const overlay = document.getElementById('pr-detail-overlay-right');
  const panel = document.getElementById('pr-detail-panel-right');

  if (overlay) overlay.classList.remove('active');
  if (panel) panel.classList.remove('active');
}

// Setup panel event listeners
function setupPRDetailPanelHandlers() {
  const overlay = document.getElementById('pr-detail-overlay-right');
  const closeBtn = document.querySelector('#pr-detail-panel-right .close-panel');

  if (overlay) {
    overlay.addEventListener('click', closePRDetailPanel);
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', closePRDetailPanel);
  }
}

// Render PR detail panel content with tabs - minimal, modern design
function renderPRDetailPanelWithTabs(container, pr) {
  const stateClass = pr.merged ? 'merged' : pr.state;
  const stateText = pr.merged ? 'Merged' : (pr.state === 'open' ? 'Open' : 'Closed');

  let html = `
    <div class="pr-detail-header">
      <div class="pr-detail-title">${escapeHTML(pr.title || 'Pull Request')}</div>
      <div class="pr-detail-number">
        #${pr.number}
        <span class="pr-detail-state ${stateClass}">${stateText}</span>
      </div>
      <div class="pr-detail-meta">
        ${escapeHTML(pr.user?.login || 'Unknown')} wants to merge
        <strong>${pr.changed_files || 0}</strong> files from
        <code>${escapeHTML(pr.head?.ref || 'unknown')}</code> into
        <code>${escapeHTML(pr.base?.ref || 'unknown')}</code>
      </div>
      <div class="pr-detail-stats">
        <span class="pr-detail-additions">+${pr.additions || 0}</span>
        <span class="pr-detail-deletions">-${pr.deletions || 0}</span>
      </div>
    </div>

    <div class="pr-detail-tabs">
      <button class="pr-tab active" data-tab="conversation">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Z"/>
        </svg>
        Conversation
        <span class="count">${(pr.comments?.length || 0) + 1}</span>
      </button>
      <button class="pr-tab" data-tab="files">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/>
        </svg>
        Files changed
        <span class="count">${pr.changed_files || 0}</span>
      </button>
    </div>

    <div class="pr-detail-tab-content">
      <div class="pr-tab-pane active" id="conversation-pane">
        ${renderConversationTab(pr)}
      </div>
      <div class="pr-tab-pane" id="files-pane">
        ${renderFilesTab(pr)}
      </div>
    </div>
  `;

  container.innerHTML = html;

  // Setup tab switching
  const tabs = container.querySelectorAll('.pr-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('data-tab');

      // Update active tab
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      // Update active pane
      const panes = container.querySelectorAll('.pr-tab-pane');
      panes.forEach((pane) => pane.classList.remove('active'));
      container.querySelector(`#${tabName}-pane`).classList.add('active');
    });
  });

  // Attach event listeners to action buttons
  setupActionButtons(container, pr);
}

// Render conversation tab
function renderConversationTab(pr) {
  const reviewStatus = getReviewStatus(pr);

  let html = `
    <div class="pr-conversation-container">
      <!-- Description -->
      <div class="pr-comment">
        <div class="pr-comment-header">
          <strong>${escapeHTML(pr.user?.login || 'Unknown')}</strong> opened this pull request
          <span class="pr-comment-time">${formatTimeAgo(pr.created_at)}</span>
        </div>
        <div class="pr-comment-body">
          ${escapeHTML(pr.body || 'No description provided.')}
        </div>
      </div>

      <!-- Comments -->
      ${renderComments(pr)}

      <!-- Review Status -->
      <div class="pr-review-status">
        <div class="pr-status-indicator" style="color: ${reviewStatus.color};">
          ${reviewStatus.text}
        </div>
      </div>

      <!-- Comment Form -->
      ${pr.state === 'open' ? `
        <div class="pr-comment-form">
          <div class="pr-comment-textarea-wrapper">
            <textarea
              id="pr-new-comment-${pr.number}"
              class="pr-comment-textarea"
              placeholder="Leave a comment..."
              rows="4"
            ></textarea>
            <button class="comment-send-btn" data-pr="${pr.number}" data-action="comment" title="Send comment">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13.402 5.744a1.13 1.13 0 0 1 0 2.076L1.913 14.782a1.343 1.343 0 0 1-1.85-1.463L.99 8Zm.603-5.288L2.38 7.25h4.87a.75.75 0 0 1 0 1.5H2.38l-.788 4.538L13.929 8Z"/>
              </svg>
            </button>
          </div>
        </div>
      ` : ''}

      <!-- Action buttons (if open) -->
      ${pr.state === 'open' ? `
        <div class="pr-detail-actions">
          <button class="approve" data-pr="${pr.number}" data-action="approve">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
            </svg>
            Approve
          </button>
          <button class="changes" data-pr="${pr.number}" data-action="changes">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
            </svg>
            Request Changes
          </button>
        </div>
      ` : ''}
    </div>
  `;

  return html;
}

// Render comments
function renderComments(pr) {
  if (!pr.comments || pr.comments.length === 0) {
    return '<div class="pr-no-comments">No comments yet</div>';
  }

  return pr.comments.map((comment) => `
    <div class="pr-comment">
      <div class="pr-comment-header">
        <strong>${escapeHTML(comment.user?.login || 'Unknown')}</strong> commented
        <span class="pr-comment-time">${formatTimeAgo(comment.created_at)}</span>
      </div>
      <div class="pr-comment-body">
        ${escapeHTML(comment.body || '')}
      </div>
    </div>
  `).join('');
}

// Render files changed tab
function renderFilesTab(pr) {
  if (!pr.diffText) {
    return '<div class="pr-loading">Loading file changes...</div>';
  }

  // Parse diff text to extract file information
  const files = parseDiffText(pr.diffText);

  if (files.length === 0) {
    return '<div class="pr-no-files">No file changes</div>';
  }

  let html = `
    <div class="pr-files-container">
      <div class="pr-files-summary">
        <strong>${files.length}</strong> ${files.length === 1 ? 'file' : 'files'} changed
      </div>
  `;

  files.forEach((file) => {
    html += `
      <div class="pr-file">
        <div class="pr-file-header">
          <span class="pr-file-name">${escapeHTML(file.name)}</span>
          <span class="pr-file-stats">
            <span class="additions">+${file.additions}</span>
            <span class="deletions">-${file.deletions}</span>
          </span>
        </div>
        <div class="pr-file-diff">
          ${renderColoredDiff(file.diffLines)}
        </div>
      </div>
    `;
  });

  html += `</div>`;

  return html;
}

// Render colored diff with proper formatting
function renderColoredDiff(diffLines) {
  if (!diffLines || diffLines.length === 0) {
    return '<div class="pr-no-diff">No changes</div>';
  }

  let html = '<div class="diff-table">';

  diffLines.forEach((line) => {
    let lineClass, marker;

    if (line.type === 'hunk') {
      lineClass = 'hunk-code';
      marker = '@';
      html += `
        <div class="diff-line ${lineClass}">
          <span class="diff-marker">${marker}</span>
          <span class="diff-content">${escapeHTML(line.content)}</span>
        </div>
      `;
    } else {
      lineClass = line.type === 'add' ? 'add-code' : line.type === 'del' ? 'del-code' : 'context-code';
      marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';

      html += `
        <div class="diff-line ${lineClass}">
          <span class="diff-marker">${marker}</span>
          <span class="diff-content">${escapeHTML(line.content)}</span>
        </div>
      `;
    }
  });

  html += '</div>';

  return html;
}

// Parse diff text to extract file information
function parseDiffText(diffText) {
  const files = [];
  const chunks = diffText.split(/(?=diff --git)/);

  chunks.forEach((chunk) => {
    if (!chunk.trim()) return;

    const match = chunk.match(/diff --git a\/(.*?) b\/(.*?)\n/);
    if (!match) return;

    const fileName = match[2];
    let status = 'modified';

    if (chunk.includes('new file mode')) {
      status = 'added';
    } else if (chunk.includes('deleted file mode')) {
      status = 'deleted';
    } else if (chunk.includes('rename from')) {
      status = 'renamed';
    }

    // Parse diff lines with type classification
    const diffLines = [];
    let additions = 0;
    let deletions = 0;
    const lines = chunk.split('\n');
    let inDiffContent = false;

    lines.forEach((line) => {
      // Skip header lines
      if (line.startsWith('diff --git') || line.startsWith('index ') ||
          line.startsWith('---') || line.startsWith('+++') ||
          line.startsWith('new file mode') || line.startsWith('deleted file mode') ||
          line.startsWith('rename from') || line.startsWith('rename to')) {
        return;
      }

      // Start processing after header
      if (line.startsWith('@@')) {
        inDiffContent = true;
        diffLines.push({
          type: 'hunk',
          content: line,
        });
        return;
      }

      if (inDiffContent) {
        if (line.startsWith('+')) {
          additions++;
          diffLines.push({
            type: 'add',
            content: line.substring(1), // Remove + marker
          });
        } else if (line.startsWith('-')) {
          deletions++;
          diffLines.push({
            type: 'del',
            content: line.substring(1), // Remove - marker
          });
        } else if (line.startsWith(' ') || line === '') {
          diffLines.push({
            type: 'context',
            content: line.substring(1) || '', // Remove space marker
          });
        }
      }
    });

    files.push({
      name: fileName,
      status,
      additions,
      deletions,
      diffLines,
    });
  });

  return files;
}

// Format time ago
function formatTimeAgo(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

// Setup action buttons
function setupActionButtons(container, pr) {
  const approveBtn = container.querySelector('[data-action="approve"]');
  const changesBtn = container.querySelector('[data-action="changes"]');
  const commentBtn = container.querySelector('[data-action="comment"]');

  if (approveBtn) {
    approveBtn.addEventListener('click', async () => {
      approveBtn.disabled = true;
      approveBtn.textContent = 'Submitting...';
      const success = await submitPRReview(pr.number, 'APPROVE', '');
      if (success) {
        setTimeout(() => {
          closePRDetailPanel();
        }, 500);
      } else {
        approveBtn.disabled = false;
        approveBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
          </svg>
          Approve
        `;
      }
    });
  }

  if (changesBtn) {
    changesBtn.addEventListener('click', async () => {
      changesBtn.disabled = true;
      changesBtn.textContent = 'Submitting...';
      const success = await submitPRReview(pr.number, 'REQUEST_CHANGES', 'Please address the issues');
      if (success) {
        setTimeout(() => {
          closePRDetailPanel();
        }, 500);
      } else {
        changesBtn.disabled = false;
        changesBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
          </svg>
          Request Changes
        `;
      }
    });
  }

  if (commentBtn) {
    commentBtn.addEventListener('click', async () => {
      const textarea = container.querySelector(`#pr-new-comment-${pr.number}`);
      const comment = textarea?.value?.trim();

      if (!comment) {
        showErrorToast('Please enter a comment');
        return;
      }

      commentBtn.disabled = true;
      const originalHTML = commentBtn.innerHTML;

      const success = await submitPRComment(pr.number, comment);

      if (success) {
        // Add comment to PR object
        if (!pr.comments) pr.comments = [];
        pr.comments.push({
          user: { login: 'You' },
          created_at: new Date().toISOString(),
          body: comment,
        });

        // Find conversation container and add new comment
        const conversationPane = container.querySelector('#conversation-pane .pr-conversation-container');
        if (conversationPane) {
          const reviewStatus = conversationPane.querySelector('.pr-review-status');
          const newCommentHTML = `
            <div class="pr-comment">
              <div class="pr-comment-header">
                <strong>You</strong> commented
                <span class="pr-comment-time">just now</span>
              </div>
              <div class="pr-comment-body">
                ${escapeHTML(comment)}
              </div>
            </div>
          `;
          if (reviewStatus) {
            reviewStatus.insertAdjacentHTML('beforebegin', newCommentHTML);
          }
        }

        textarea.value = '';
        showInfoToast('Comment posted successfully');
      }

      commentBtn.disabled = false;
      commentBtn.innerHTML = originalHTML;
    });
  }
}

// Submit PR comment
async function submitPRComment(prNumber, comment) {
  try {
    const formData = new FormData();
    formData.append('content', comment);

    const response = await POST(`/${globalOwner}/${globalRepo}/issues/${prNumber}/comments`, {
      data: formData,
    });

    if (response.ok) {
      return true;
    } else {
      const text = await response.text().catch(() => '');
      showErrorToast(text || `Failed to post comment (${response.status})`);
      return false;
    }
  } catch (error) {
    console.error('Comment submission error:', error);
    showErrorToast('Failed to post comment: ' + error.message);
    return false;
  }
}

// Helper: Escape HTML
function escapeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Helper: Get review status from PR reviews
function getReviewStatus(pr) {
  if (!pr.reviews || pr.reviews.length === 0) {
    return { text: 'No reviews', color: '#666' };
  }

  const approved = pr.reviews.some(r => r.state === 'APPROVED');
  const changesRequested = pr.reviews.some(r => r.state === 'CHANGES_REQUESTED');

  if (changesRequested) {
    return { text: 'Changes requested', color: '#ef4444' };
  }
  if (approved) {
    return { text: 'Approved', color: '#22c55e' };
  }
  return { text: `${pr.reviews.length} reviews`, color: '#666' };
}

// Submit PR review using web endpoint
async function submitPRReview(prNumber, event, body) {
  try {
    // Map event to form type
    const typeMap = {
      'APPROVE': 'approve',
      'REQUEST_CHANGES': 'reject',
      'COMMENT': 'comment',
    };

    // Use web endpoint instead of API endpoint for proper authentication
    const formData = new FormData();
    formData.append('type', typeMap[event] || 'comment');
    formData.append('content', body || '');
    formData.append('commit_id', ''); // Empty for overall review

    const response = await POST(`/${globalOwner}/${globalRepo}/pulls/${prNumber}/files/reviews/submit`, {
      data: formData,
    });

    if (response.ok) {
      showInfoToast(`Review submitted successfully`);
      return true;
    } else {
      const text = await response.text().catch(() => '');
      showErrorToast(text || `Failed to submit review (${response.status})`);
      return false;
    }
  } catch (error) {
    console.error('Review submission error:', error);
    showErrorToast('Failed to submit review: ' + error.message);
    return false;
  }
}

// ============================================================================
// Commit Context Menu Functions
// ============================================================================

/**
 * Show context menu on right-click of commit node
 */
function showCommitContextMenu(event, commit) {
  // Remove any existing context menu
  hideCommitContextMenu();

  // Set the selected commit for actions
  setSelectedCommit(commit.sha, commit.origin_branch);

  // Create context menu element
  const menu = document.createElement('div');
  menu.id = 'commit-context-menu';
  menu.className = 'commit-context-menu';

  // Determine if commit is on main/master branch
  const isMainBranch = commit.origin_branch === 'main' || commit.origin_branch === 'master';

  // Build menu items
  let menuHTML = '<div class="context-menu-item" data-action="create-issue">Create Issue</div>';

  // Only show "Create Pull Request" if not on main branch
  if (!isMainBranch) {
    menuHTML += '<div class="context-menu-item" data-action="create-pr">Create Pull Request</div>';
  }

  menu.innerHTML = menuHTML;

  // Position the menu at cursor location
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  // Add to document
  document.body.appendChild(menu);

  // Add event listeners to menu items
  menu.querySelectorAll('.context-menu-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      const action = e.target.getAttribute('data-action');
      handleContextMenuAction(action, commit);
      hideCommitContextMenu();
    });
  });

  // Close menu when clicking elsewhere
  setTimeout(() => {
    document.addEventListener('click', hideCommitContextMenu, {once: true});
    document.addEventListener('contextmenu', hideCommitContextMenu, {once: true});
  }, 0);
}

/**
 * Hide/remove context menu
 */
function hideCommitContextMenu() {
  const menu = document.getElementById('commit-context-menu');
  if (menu) {
    menu.remove();
  }
}

/**
 * Handle context menu action selection
 */
async function handleContextMenuAction(action, commit) {
  if (action === 'create-issue') {
    await openCreateIssueModal();
  } else if (action === 'create-pr') {
    // Navigate to PR creation page with pre-filled branch
    const branch = commit.origin_branch || 'unknown';
    const prUrl = `/${globalOwner}/${globalRepo}/compare/main...${branch}`;
    window.location.href = prUrl;
  }
}

// Helper: Determine origin branch based on column position
// Extract branch name from commit's refs (actual git references)
function extractBranchFromRefs(commit) {
  if (!commit.refs || commit.refs.length === 0) return null;

  // Find first branch ref (not tag)
  const branchRef = commit.refs.find(ref => ref.startsWith('refs/heads/'));
  if (branchRef) {
    return branchRef.replace('refs/heads/', '');
  }
  return null;
}

function determineOriginBranch(commit, column) {
  // First, try to use the actual git refs
  const refBranch = extractBranchFromRefs(commit);

  if (column === 0) {
    // Column 0 is main branch
    if (refBranch === 'main' || refBranch === 'master') return refBranch;
    const mainBranch = commit.branches?.find(b => b === 'main' || b === 'master');
    return mainBranch || refBranch || 'main';
  } else {
    // Other columns: prefer non-main branches
    // Use refs first, then API branches
    if (refBranch && refBranch !== 'main' && refBranch !== 'master') {
      return refBranch;
    }

    const nonMainBranch = commit.branches?.find(b => b !== 'main' && b !== 'master');
    if (nonMainBranch) return nonMainBranch;

    // If only main/master in branches, use refs anyway
    if (refBranch) return refBranch;

    // Last resort: use first branch or mark for propagation
    return commit.branches?.[0] || null;  // null = needs propagation
  }
}

// Create column-based boundaries - commits grouped by (column, branch) with stack tracking
function createColumnBasedBoundaries(commits) {
  // Step 1: Determine origin branch for each commit based on column
  // Each commit gets EXACTLY ONE label based on where it was created
  commits.forEach(commit => {
    commit.origin_branch = determineOriginBranch(commit, commit.column);
  });

  // Step 1.5: Propagate branch names within columns for commits without labels
  const columnGroups = new Map();
  commits.forEach(commit => {
    if (!columnGroups.has(commit.column)) {
      columnGroups.set(commit.column, []);
    }
    columnGroups.get(commit.column).push(commit);
  });

  columnGroups.forEach((columnCommits, column) => {
    // Sort by row
    columnCommits.sort((a, b) => a.row - b.row);

    // Find first commit with a branch name and propagate downward
    let activeBranch = null;

    // First pass: find any commit with refs to establish branch name
    for (const commit of columnCommits) {
      if (commit.origin_branch && commit.origin_branch !== null) {
        activeBranch = commit.origin_branch;
        break;
      }
    }

    // Fallback: use column 0 = main, others = first non-main from API
    if (!activeBranch) {
      if (column === 0) {
        activeBranch = 'main';
      } else {
        // Find any commit with a non-main branch
        for (const commit of columnCommits) {
          const nonMain = commit.branches?.find(b => b !== 'main' && b !== 'master');
          if (nonMain) {
            activeBranch = nonMain;
            break;
          }
        }
        if (!activeBranch) {
          activeBranch = columnCommits[0]?.branches?.[0] || `column-${column}`;
        }
      }
    }

    // Second pass: assign branch to all commits, updating when we see refs change
    for (const commit of columnCommits) {
      if (commit.origin_branch && commit.origin_branch !== null) {
        activeBranch = commit.origin_branch;
      }
      commit.origin_branch = activeBranch;
    }
  });

  // Log assignments
  commits.forEach(commit => {
    console.log(`[Label Assignment] Commit ${commit.sha.substring(0, 7)} (col ${commit.column}, row ${commit.row}): refs=[${commit.refs?.join(', ') || 'none'}], API branches=[${commit.branches?.join(', ') || 'none'}] → origin_branch='${commit.origin_branch}'`);
  });

  // Step 2: Create boundaries from the already-grouped columns
  const boundaries = [];

  columnGroups.forEach((columnCommits, column) => {
    // Sort by row (top to bottom = oldest to newest)
    columnCommits.sort((a, b) => a.row - b.row);

    // Track active branch boxes: branch -> {startIdx, commits[]}
    const activeBranches = new Map();

    console.log(`[Column ${column}] Processing ${columnCommits.length} commits`);

    for (let i = 0; i < columnCommits.length; i++) {
      const commit = columnCommits[i];
      const nextCommit = columnCommits[i + 1];

      // Use ONLY origin_branch (single label based on column)
      const currentOriginBranch = commit.origin_branch;
      const nextOriginBranch = nextCommit?.origin_branch;

      console.log(`  [Row ${commit.row}, Col ${column}] Commit ${commit.sha.substring(0, 7)} origin_branch='${currentOriginBranch}'`);

      // If this origin branch is not active, start tracking it
      if (!activeBranches.has(currentOriginBranch)) {
        activeBranches.set(currentOriginBranch, {
          startIdx: i,
          commits: []
        });
        console.log(`    → Starting branch '${currentOriginBranch}'`);
      }

      // Add current commit to this branch's tracking
      activeBranches.get(currentOriginBranch).commits.push(commit);

      // Close branch if next commit has different origin_branch (or end of column)
      if (!nextCommit || nextOriginBranch !== currentOriginBranch) {
        const branchData = activeBranches.get(currentOriginBranch);
        if (branchData.commits.length >= 2) {
          boundaries.push({
            branch: currentOriginBranch,
            commits: branchData.commits,
            column: column
          });
          console.log(`    → Closing branch '${currentOriginBranch}' - ${branchData.commits.length} commits (rows ${branchData.commits[0].row}-${commit.row})`);
        } else {
          console.log(`    → Closing branch '${currentOriginBranch}' - only ${branchData.commits.length} commit(s), skipping`);
        }
        activeBranches.delete(currentOriginBranch);
      }
    }
  });

  console.log(`[Column-Based Boundaries] Created ${boundaries.length} boundaries from ${columnGroups.size} columns`);
  boundaries.forEach(b => {
    console.log(`  Column ${b.column}, branch '${b.branch}': ${b.commits.length} commits (rows ${b.commits[0].row}-${b.commits[b.commits.length-1].row})`);
  });

  return boundaries;
}

function drawBranchBoundaries(commits, boundariesGroup) {
  // Create column-based boundaries
  const boundaries = createColumnBasedBoundaries(commits);

  console.log(`[Boundary Drawing] Drawing ${boundaries.length} column-based boundaries`);

  let colorIndex = 0;

  boundaries.forEach(({branch, commits: boundaryCommits, column}) => {
    // Calculate bounding box around all commits in this boundary
    const positions = boundaryCommits.map(c => ({
      x: c.column * COLUMN_SPACING + COLUMN_SPACING,
      y: c.row * ROW_SPACING + (ROW_SPACING / 2)
    }));

    const minX = Math.min(...positions.map(p => p.x)) - CARD_WIDTH / 2 - 20;
    const maxX = Math.max(...positions.map(p => p.x)) + CARD_WIDTH / 2 + 20;
    const minY = Math.min(...positions.map(p => p.y)) - CARD_HEIGHT / 2 - 20;
    const maxY = Math.max(...positions.map(p => p.y)) + CARD_HEIGHT / 2 + 20;

    const width = maxX - minX;
    const height = maxY - minY;

    // Get branch color (cycle through color palette)
    const branchColor = getBranchColor(colorIndex++);

    // Draw dashed boundary rectangle
    const boundary = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    boundary.setAttribute('x', minX);
    boundary.setAttribute('y', minY);
    boundary.setAttribute('width', width);
    boundary.setAttribute('height', height);
    boundary.setAttribute('rx', '12');
    boundary.setAttribute('ry', '12');
    boundary.setAttribute('fill', 'none');
    boundary.setAttribute('stroke', branchColor);
    boundary.setAttribute('stroke-width', '1.5');
    boundary.setAttribute('stroke-dasharray', '8 6');
    boundary.setAttribute('opacity', '0.5');
    boundary.setAttribute('class', 'branch-boundary');
    boundary.setAttribute('data-branch', branch);
    boundary.setAttribute('data-column', column);
    boundariesGroup.appendChild(boundary);

    // Add branch label with branch name
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', minX + 12);
    label.setAttribute('y', minY - 6);
    label.setAttribute('class', 'branch-label');
    label.setAttribute('fill', branchColor);
    label.setAttribute('font-size', '11');
    label.setAttribute('font-weight', '600');
    label.setAttribute('opacity', '0.9');
    label.textContent = branch;
    boundariesGroup.appendChild(label);

    console.log(`[Boundary Drawing] Drew boundary for column ${column}, branch '${branch}' (${boundaryCommits.length} commits) at (${minX.toFixed(0)}, ${minY.toFixed(0)}) - (${maxX.toFixed(0)}, ${maxY.toFixed(0)})`);
  });

  console.log(`[Boundary Drawing] Summary: Drew ${boundaries.length} column-based boundaries`);
}

async function fetchAllIssuesWithCommits(owner, repo) {
  try {
    // Fetch all issues (open and closed) from the repository
    const response = await GET(`/api/v1/repos/${owner}/${repo}/issues?state=all&limit=100`);
    if (!response.ok) return [];
    return await response.json();
  } catch (error) {
    console.error('Failed to fetch issues:', error);
    return [];
  }
}

function attachIssuesToCommits(commits, issues) {
  // Create a map of commit SHA to linked issues
  const commitIssueMap = new Map();

  // For each issue, check if it mentions any commit SHAs in body or title
  issues.forEach(issue => {
    const searchText = `${issue.title} ${issue.body || ''}`;

    commits.forEach(commit => {
      // Check if the issue mentions this commit (full SHA or short SHA)
      const shortSha = commit.sha.substring(0, 7);
      if (searchText.includes(commit.sha) || searchText.includes(shortSha)) {
        if (!commitIssueMap.has(commit.sha)) {
          commitIssueMap.set(commit.sha, []);
        }
        commitIssueMap.get(commit.sha).push(issue);
      }
    });
  });

  // Attach linked issues to each commit
  commits.forEach(commit => {
    commit.linked_issues = commitIssueMap.get(commit.sha) || [];
  });
}

async function loadCommitGraph(owner, repo, container) {
  const loading = document.getElementById('loading');
  const errorDiv = document.getElementById('error');
  const graphContainer = document.getElementById('devtree-graph-container');

  try {
    // Fetch graph data and issues in parallel
    const [graphData, issues] = await Promise.all([
      fetchGraphData(owner, repo, 1),
      fetchAllIssuesWithCommits(owner, repo)
    ]);

    // Attach issues to commits before rendering
    attachIssuesToCommits(graphData.commits, issues);

    await renderGraph(graphContainer, graphData, owner, repo);
    loading.style.display = 'none';
  } catch (error) {
    console.error('Failed to load commit graph:', error);
    loading.style.display = 'none';
    errorDiv.style.display = 'block';
    document.getElementById('error-text').textContent = error.message;
    showErrorToast(`Failed to load commit graph: ${error.message}`);
  }
}

// API: Fetch all branches
async function fetchAllBranches(owner, repo) {
  try {
    const response = await GET(`/api/v1/repos/${owner}/${repo}/branches`);
    if (!response.ok) {
      console.error('Failed to fetch branches:', response.status);
      return [];
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching branches:', error);
    return [];
  }
}

// API: Fetch commits for a specific branch
async function fetchCommitsForBranch(owner, repo, branchName) {
  try {
    const response = await GET(`/api/v1/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branchName)}&limit=0`);
    if (!response.ok) {
      console.error(`Failed to fetch commits for branch ${branchName}:`, response.status);
      return [];
    }
    return await response.json();
  } catch (error) {
    console.error(`Error fetching commits for branch ${branchName}:`, error);
    return [];
  }
}

// API: Fetch detailed commit information including parents
async function fetchCommitDetails(owner, repo, sha) {
  try {
    const response = await GET(`/api/v1/repos/${owner}/${repo}/git/commits/${sha}`);
    if (!response.ok) {
      console.error(`Failed to fetch commit details for ${sha}:`, response.status);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error(`Error fetching commit details for ${sha}:`, error);
    return null;
  }
}

// Build commit to branch affiliation map
async function buildCommitBranchMap(owner, repo) {
  // Fetch all branches
  const branches = await fetchAllBranches(owner, repo);
  console.log(`Found ${branches.length} branches:`, branches.map(b => b.name));

  // Map: commit SHA -> Set of branch names
  const commitToBranches = new Map();

  // For each branch, fetch its commits
  for (const branch of branches) {
    const branchName = branch.name;
    const commits = await fetchCommitsForBranch(owner, repo, branchName);

    console.log(`Branch ${branchName}: ${commits.length} commits`);

    // Add each commit to the map
    for (const commit of commits) {
      const sha = commit.sha || commit.id;
      if (!commitToBranches.has(sha)) {
        commitToBranches.set(sha, new Set());
      }
      commitToBranches.get(sha).add(branchName);
    }
  }

  // Log summary of branch affiliations
  console.log(`[Branch Affiliation] Total unique commits: ${commitToBranches.size}`);
  const multibranchCommits = Array.from(commitToBranches.entries()).filter(([, branches]) => branches.size > 1);
  console.log(`[Branch Affiliation] Commits in multiple branches: ${multibranchCommits.length}`);
  if (multibranchCommits.length > 0) {
    console.log('[Branch Affiliation] Multi-branch commits:', multibranchCommits.slice(0, 5).map(([sha, branches]) => ({
      sha: sha.substring(0, 7),
      branches: Array.from(branches)
    })));
  }

  return commitToBranches;
}

// Helper: Extract branch name from commit refs
function extractBranchName(commit) {
  if (!commit.refs || commit.refs.length === 0) return null;

  // Find first branch ref (ignore tags)
  const branchRef = commit.refs.find(ref => ref.startsWith('refs/heads/'));
  return branchRef ? branchRef.replace('refs/heads/', '') : null;
}

// Fetch all PRs (open, merged, closed)
async function fetchAllPRs(owner, repo) {
  const states = ['open', 'closed']; // closed includes both merged and not-merged
  const allPRs = [];

  for (const state of states) {
    try {
      const response = await GET(`/api/v1/repos/${owner}/${repo}/pulls?state=${state}&limit=100`);
      if (response.ok) {
        const prs = await response.json();
        allPRs.push(...prs);
        console.log(`[PR Fetch] Found ${prs.length} ${state} PRs`);
      }
    } catch (error) {
      console.error(`Failed to fetch ${state} PRs:`, error);
    }
  }

  console.log(`[PR Fetch] Total PRs: ${allPRs.length}`);
  return allPRs;
}

// Match PRs to commits by SHA
function matchPRsToCommits(commits, prs) {
  const commitToPR = new Map();

  for (const pr of prs) {
    console.log(`[PR Match] Processing PR #${pr.number}:`, {
      state: pr.state,
      merged: pr.merged,
      head_sha: pr.head?.sha?.substring(0, 7),
      merge_commit_sha: pr.merge_commit_sha?.substring(0, 7)
    });

    if (pr.merged && pr.merge_commit_sha) {
      // Merged PR: show at merge commit
      commitToPR.set(pr.merge_commit_sha, pr);
      console.log(`[PR Match] Merged PR #${pr.number} -> commit ${pr.merge_commit_sha.substring(0, 7)}`);
    } else if (pr.state === 'open' && pr.head && pr.head.sha) {
      // Open PR: show at head commit of the PR branch
      commitToPR.set(pr.head.sha, pr);
      console.log(`[PR Match] Open PR #${pr.number} -> head commit ${pr.head.sha.substring(0, 7)}`);
    }
    // Closed (not merged) PRs: don't show icon
  }

  // Attach PR to commits
  let matchCount = 0;
  commits.forEach(commit => {
    const pr = commitToPR.get(commit.sha);
    if (pr) {
      commit.pullRequest = pr;
      matchCount++;
      console.log(`[PR Match] Commit ${commit.sha.substring(0, 7)} linked to PR #${pr.number} (${pr.state}${pr.merged ? ', merged' : ''})`);
    }
  });

  console.log(`[PR Match] Linked ${matchCount} commits to PRs`);
  return commitToPR;
}

// Enhanced layout function - affiliates commits with branches using API
async function prepareGraphLayout(commits, owner, repo) {
  // Build commit map for lookups
  const commitMap = new Map();
  commits.forEach(c => commitMap.set(c.sha, c));

  // Fetch commit-to-branch affiliations from API
  console.log('Fetching branch affiliations...');
  const commitToBranches = await buildCommitBranchMap(owner, repo);

  // Affiliate each commit with branches
  commits.forEach(commit => {
    const branches = commitToBranches.get(commit.sha);
    if (branches && branches.size > 0) {
      commit.branches = Array.from(branches);
      commit.branch_name = commit.branches[0]; // Primary branch (first one)
    } else {
      // Fallback to refs-based extraction
      commit.branch_name = extractBranchName(commit) || 'unknown';
      commit.branches = [commit.branch_name];
    }
  });

  // Log commit affiliation summary
  const affiliatedCommits = commits.filter(c => c.branches && c.branches.length > 0);
  const fallbackCommits = commits.filter(c => c.branch_name === 'unknown' || !commitToBranches.has(c.sha));
  console.log(`[Commit Affiliation] Total commits: ${commits.length}`);
  console.log(`[Commit Affiliation] API-affiliated: ${affiliatedCommits.length - fallbackCommits.length}`);
  console.log(`[Commit Affiliation] Fallback/Unknown: ${fallbackCommits.length}`);

  // Sample affiliations
  const sampleCommits = commits.slice(0, 3);
  console.log('[Commit Affiliation] Sample commits:', sampleCommits.map(c => ({
    sha: c.sha.substring(0, 7),
    branches: c.branches,
    primary: c.branch_name
  })));

  // Fetch parent information from API for each commit
  console.log('Fetching commit details for parent information...');
  for (const commit of commits) {
    const commitDetails = await fetchCommitDetails(owner, repo, commit.sha);
    if (commitDetails && commitDetails.parents) {
      // Update parent information from API
      commit.parents = commitDetails.parents.map(p => p.sha);
      console.log(`Commit ${commit.sha.substring(0, 7)}: ${commit.parents.length} parent(s)`);
    } else if (!commit.parents) {
      // If API fails and no existing parent data, initialize as empty
      commit.parents = [];
    }
  }

  // Build children map for edge drawing (using API parent data)
  const children = new Map();
  commits.forEach(c => children.set(c.sha, []));
  commits.forEach(c => {
    (c.parents || []).forEach(p => {
      if (children.has(p)) children.get(p).push(c.sha);
    });
  });

  // Use backend's row and column values directly
  // The backend already calculated correct positions from git log --graph
  // DON'T recalculate - trust the backend!

  // Note: Branch boundaries are now drawn using column-based algorithm
  // in drawBranchBoundaries() - no need to pre-group by branch

  // Fetch and match PRs to commits
  console.log('[DevTree] Fetching PRs...');
  const prs = await fetchAllPRs(owner, repo);
  console.log('[DevTree] Found', prs.length, 'PRs');
  matchPRsToCommits(commits, prs);
  const commitsWithPRs = commits.filter(c => c.pullRequest);
  console.log('[DevTree] Matched', commitsWithPRs.length, 'commits to PRs');

  return {
    commits,
    commitMap,
    children,
    commitToBranches
  };
}

async function renderGraph(container, graphData, owner, repo) {
  console.log('[DevTree] renderGraph called', {
    container: container?.id,
    commitCount: graphData?.commits?.length,
    flowCount: graphData?.flows?.length
  });

  const commits = graphData.commits;
  if (!commits || commits.length === 0) {
    console.warn('[DevTree] No commits to display');
    container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--color-text-light);">No commits to display</div>';
    return;
  }

  // Store data globally for branch lookups
  globalFlows = graphData.flows || [];

  // Show loading indicator while fetching branch data
  container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--color-text-light);"><div class="ui active centered inline loader"></div><p style="margin-top: 20px;">Loading branch affiliations and PRs...</p></div>';

  // Prepare graph layout - uses backend's row/column values and API branch data
  const layoutResult = await prepareGraphLayout(commits, owner, repo);
  const orderedCommits = layoutResult.commits;
  const commitMap = layoutResult.commitMap;
  globalCommits = orderedCommits;

  // Calculate dimensions
  const minRow = Math.min(...orderedCommits.map((c) => c.row));
  const maxRow = Math.max(...orderedCommits.map((c) => c.row));
  const minColumn = Math.min(...orderedCommits.map((c) => c.column));
  const maxColumn = Math.max(...orderedCommits.map((c) => c.column));

  // Build flow color map from API data (for commit card colors)
  const flows = globalFlows;
  const flowColorMap = new Map();
  flows.forEach(flow => {
    flowColorMap.set(flow.id, flow.color);
  });

  // Clear container
  container.innerHTML = '';

  // Create SVG with larger dimensions
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

  // Calculate viewBox with padding
  const padding = COLUMN_SPACING * 2;
  const viewBoxX = minColumn * COLUMN_SPACING - padding;
  const viewBoxY = minRow * ROW_SPACING - padding;
  const viewBoxWidth = (maxColumn - minColumn + 1) * COLUMN_SPACING + padding * 2;
  const viewBoxHeight = (maxRow - minRow + 1) * ROW_SPACING + padding * 2;

  svg.setAttribute('viewBox', `${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');

  // Store viewBox for reset
  currentViewBox = {x: viewBoxX, y: viewBoxY, width: viewBoxWidth, height: viewBoxHeight};

  // Add grid pattern
  addGridPattern(svg);

  // Add background rectangle with grid
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('x', viewBoxX);
  background.setAttribute('y', viewBoxY);
  background.setAttribute('width', viewBoxWidth);
  background.setAttribute('height', viewBoxHeight);
  background.setAttribute('fill', 'url(#grid-pattern)');
  svg.appendChild(background);

  // Create pan-zoom group
  panZoomGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  panZoomGroup.setAttribute('id', 'pan-zoom-group');
  svg.appendChild(panZoomGroup);

  // Draw flows - separate layers for proper layering
  const branchBoundariesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  branchBoundariesGroup.setAttribute('class', 'branch-boundaries-layer');
  const pathsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  pathsGroup.setAttribute('class', 'paths-layer');
  const circlesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  circlesGroup.setAttribute('class', 'circles-layer');

  // Default gray color for cross-branch edges
  const CROSS_BRANCH_COLOR = 'rgba(255, 255, 255, 0.3)';

  // Track drawn edges to avoid duplicates
  const drawnEdges = new Set();

  // Draw all edges:
  // - Edges from child commits to ALL their parents
  // - For merge commits: connects to both main branch parent AND merged branch parent
  // - Vertical lines within same column, curved lines between columns
  console.log('[DevTree] Drawing edges for', orderedCommits.length, 'commits');
  let edgeCount = 0;
  orderedCommits.forEach((commit) => {
    const x = commit.column * COLUMN_SPACING + COLUMN_SPACING;
    const y = commit.row * ROW_SPACING + (ROW_SPACING / 2);
    const commitFlowId = commit.flow_id;
    const commitColor = flowColorMap.get(commitFlowId) || 0;

    // Get ALL parents (includes merged branch for merge commits)
    const parents = commit.parents || [];
    if (parents.length === 0) return;

    const isMergeCommit = parents.length > 1;

    // Draw edge to EVERY parent
    // For merge commits: first parent is main branch, rest are merged branches
    parents.forEach((parentSha, parentIndex) => {
      const parent = commitMap.get(parentSha);
      if (!parent) {
        console.warn(`Parent ${parentSha} not found for commit ${commit.sha}`);
        return;
      }

      // Create unique edge key to prevent duplicates
      const edgeKey = `${commit.sha}-${parentSha}`;
      if (drawnEdges.has(edgeKey)) return;
      drawnEdges.add(edgeKey);

      const parentX = parent.column * COLUMN_SPACING + COLUMN_SPACING;
      const parentY = parent.row * ROW_SPACING + (ROW_SPACING / 2);

      // Determine edge color based on commit's branch
      const edgeColor = getBranchColor(commitColor);

      // Start from top center of child commit card (child is lower on screen)
      const startY = y - CARD_HEIGHT / 2;
      // End at bottom center of parent card (parent is higher on screen)
      const endY = parentY + CARD_HEIGHT / 2;

      let pathData;
      const isMergedBranchEdge = isMergeCommit && parentIndex > 0;

      if (x === parentX) {
        // Same column - simple vertical line
        pathData = `M ${x} ${startY} L ${x} ${endY}`;
      } else {
        // Different columns - curved connecting edge
        // This handles merged branch connections
        pathData = `M ${x} ${startY} C ${x} ${(startY + endY) / 2}, ${parentX} ${(startY + endY) / 2}, ${parentX} ${endY}`;
      }

      // Create path element
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData.replace(/\s+/g, ' ').trim());
      path.setAttribute('stroke', edgeColor);
      path.setAttribute('stroke-width', STROKE_WIDTH);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('opacity', '0.6');

      // Mark merged branch edges with data attribute for debugging
      if (isMergedBranchEdge) {
        path.setAttribute('data-merged-branch', 'true');
        path.setAttribute('class', 'merge-edge');
      }

      pathsGroup.appendChild(path);
      edgeCount++;
    });
  });
  console.log('[DevTree] Edges drawn:', edgeCount);

  // Draw commit cards
  console.log('[DevTree] Drawing', orderedCommits.length, 'commit cards');
  orderedCommits.forEach((commit) => {
    const x = commit.column * COLUMN_SPACING + COLUMN_SPACING;
    const y = commit.row * ROW_SPACING + (ROW_SPACING / 2);
    const commitFlowId = commit.flow_id;
    const colorNum = flowColorMap.get(commitFlowId) || 0;

    // Create commit card node (Railway-style)
    const card = createCommitCard(commit, x, y, colorNum);

    // Add click handler for commit details
    card.addEventListener('mousedown', () => {
      globalState.panDistance = 0;
    });
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      if (globalState.panDistance < PAN_THRESHOLD) {
        // Branch name will be fetched in openCommitPanel
        openCommitPanel(commit.sha);
      }
    });

    // Add context menu handler for right-click
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCommitContextMenu(e, commit);
    });

    circlesGroup.appendChild(card);
  });
  console.log('[DevTree] Commit cards drawn:', circlesGroup.children.length);

  // Draw branch boundaries (column-based origin grouping)
  drawBranchBoundaries(orderedCommits, branchBoundariesGroup);

  // Add layers in order: boundaries first, then paths, then circles on top
  panZoomGroup.appendChild(branchBoundariesGroup);
  panZoomGroup.appendChild(pathsGroup);
  panZoomGroup.appendChild(circlesGroup);

  console.log('[DevTree] Appending SVG to container', {
    edges: pathsGroup.children.length,
    nodes: circlesGroup.children.length,
    container: container.id
  });

  container.appendChild(svg);

  // Setup pan/zoom on the container
  setupPanZoom(container, svg, viewBoxWidth, viewBoxHeight);

  // Center graph initially - wait for DOM to update
  setTimeout(() => {
    centerGraph(viewBoxX, viewBoxY, viewBoxWidth, viewBoxHeight);
  }, 0);
}

function setupPanZoom(container, svg, viewBoxWidth, viewBoxHeight) {
  let clickedElement = null;

  // Mouse down - start pan
  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // Only left click

    globalState.isPanning = true;
    globalState.panStartX = e.clientX;
    globalState.panStartY = e.clientY;
    globalState.startTranslateX = globalState.translateX;
    globalState.startTranslateY = globalState.translateY;
    globalState.panDistance = 0;
    clickedElement = e.target;

    container.classList.add('panning');
    e.preventDefault();
  });

  // Mouse move - pan (1:1 mapping with mouse movement)
  container.addEventListener('mousemove', (e) => {
    if (!globalState.isPanning) return;

    const dx = e.clientX - globalState.panStartX;
    const dy = e.clientY - globalState.panStartY;

    globalState.panDistance = Math.sqrt(dx * dx + dy * dy);

    // Direct 1:1 mapping - no scale adjustment for more natural feel
    globalState.translateX = globalState.startTranslateX + dx;
    globalState.translateY = globalState.startTranslateY + dy;

    applyTransform();
  });

  // Mouse up - end pan
  const endPan = () => {
    if (globalState.isPanning) {
      globalState.isPanning = false;
      container.classList.remove('panning');
    }
  };

  container.addEventListener('mouseup', endPan);
  container.addEventListener('mouseleave', endPan);

  // Wheel - zoom (zoom toward cursor position)
  container.addEventListener('wheel', (e) => {
    e.preventDefault();

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Calculate mouse position in SVG coordinates before zoom
    // Screen position = (SVG position * scale) + translate
    // So: SVG position = (Screen position - translate) / scale
    const svgX = (mouseX - globalState.translateX) / globalState.scale;
    const svgY = (mouseY - globalState.translateY) / globalState.scale;

    // Update scale
    const delta = -e.deltaY;
    const zoomFactor = delta > 0 ? (1 + ZOOM_SPEED) : (1 - ZOOM_SPEED);
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, globalState.scale * zoomFactor));

    if (newScale !== globalState.scale) {
      // Calculate new translation to keep mouse position fixed
      // We want: mouseX = (svgX * newScale) + newTranslateX
      // So: newTranslateX = mouseX - (svgX * newScale)
      globalState.scale = newScale;
      globalState.translateX = mouseX - (svgX * newScale);
      globalState.translateY = mouseY - (svgY * newScale);

      applyTransform();
    }
  });
}

function setupZoomControls() {
  const zoomIn = document.getElementById('zoom-in');
  const zoomOut = document.getElementById('zoom-out');
  const zoomReset = document.getElementById('zoom-reset');
  const container = document.getElementById('devtree-graph-container');

  if (zoomIn && container) {
    zoomIn.addEventListener('click', () => {
      zoomTowardCenter(container, 1 + ZOOM_SPEED);
    });
  }

  if (zoomOut && container) {
    zoomOut.addEventListener('click', () => {
      zoomTowardCenter(container, 1 - ZOOM_SPEED);
    });
  }

  if (zoomReset) {
    zoomReset.addEventListener('click', () => {
      // Re-center and fit graph using stored viewBox
      if (currentViewBox) {
        centerGraph(currentViewBox.x, currentViewBox.y, currentViewBox.width, currentViewBox.height);
      } else {
        globalState.scale = DEFAULT_SCALE;
        globalState.translateX = 0;
        globalState.translateY = 0;
        applyTransform();
      }
    });
  }

  // Fullscreen toggle
  const fullscreenBtn = document.getElementById('fullscreen-toggle');
  const devtreeContainer = document.getElementById('devtree-container');

  if (fullscreenBtn && devtreeContainer) {
    fullscreenBtn.addEventListener('click', () => {
      toggleFullscreen(devtreeContainer, fullscreenBtn);
    });

    // Listen for fullscreen state changes
    document.addEventListener('fullscreenchange', () => {
      updateFullscreenButton(fullscreenBtn);
    });
    document.addEventListener('webkitfullscreenchange', () => {
      updateFullscreenButton(fullscreenBtn);
    });
    document.addEventListener('mozfullscreenchange', () => {
      updateFullscreenButton(fullscreenBtn);
    });
    document.addEventListener('msfullscreenchange', () => {
      updateFullscreenButton(fullscreenBtn);
    });
  }
}

// Toggle fullscreen mode
function toggleFullscreen(element, button) {
  if (!document.fullscreenElement &&
      !document.webkitFullscreenElement &&
      !document.mozFullScreenElement &&
      !document.msFullscreenElement) {
    // Enter fullscreen
    if (element.requestFullscreen) {
      element.requestFullscreen();
    } else if (element.webkitRequestFullscreen) {
      element.webkitRequestFullscreen();
    } else if (element.mozRequestFullScreen) {
      element.mozRequestFullScreen();
    } else if (element.msRequestFullscreen) {
      element.msRequestFullscreen();
    }
  } else {
    // Exit fullscreen
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }
  }
}

// Update fullscreen button icon based on state
function updateFullscreenButton(button) {
  if (!button) return;

  const isFullscreen = document.fullscreenElement ||
                       document.webkitFullscreenElement ||
                       document.mozFullScreenElement ||
                       document.msFullscreenElement;

  if (isFullscreen) {
    button.textContent = '⊡'; // Exit fullscreen icon (compress/minimize)
    button.setAttribute('title', 'Exit Fullscreen');
  } else {
    button.textContent = '⛶'; // Enter fullscreen icon (expand/maximize)
    button.setAttribute('title', 'Enter Fullscreen');
  }
}

function zoomTowardCenter(container, zoomFactor) {
  const rect = container.getBoundingClientRect();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;

  // Calculate center position in SVG coordinates before zoom
  const svgX = (centerX - globalState.translateX) / globalState.scale;
  const svgY = (centerY - globalState.translateY) / globalState.scale;

  // Update scale
  const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, globalState.scale * zoomFactor));

  if (newScale !== globalState.scale) {
    // Calculate new translation to keep center position fixed
    globalState.scale = newScale;
    globalState.translateX = centerX - (svgX * newScale);
    globalState.translateY = centerY - (svgY * newScale);

    applyTransform();
  }
}

function centerGraph(viewBoxX, viewBoxY, viewBoxWidth, viewBoxHeight) {
  const container = document.getElementById('devtree-graph-container');
  if (!container) return;

  const rect = container.getBoundingClientRect();
  const containerWidth = rect.width;
  const containerHeight = rect.height;

  // Calculate scale to fit the entire graph in view with padding
  const scaleX = (containerWidth * 0.85) / viewBoxWidth;
  const scaleY = (containerHeight * 0.85) / viewBoxHeight;
  const fitScale = Math.min(scaleX, scaleY, MAX_SCALE);

  // Use the fit scale
  globalState.scale = fitScale;

  // Calculate the center of the viewBox in SVG coordinates (absolute coordinates)
  const graphCenterXInSVG = viewBoxX + (viewBoxWidth / 2);
  const graphCenterYInSVG = viewBoxY + (viewBoxHeight / 2);

  // We want the graph center to appear at the container center
  // Screen Position = (SVG Coordinate * Scale) + Translate
  // Container Center = (Graph Center SVG * Scale) + Translate
  // So: Translate = Container Center - (Graph Center SVG * Scale)
  const containerCenterX = containerWidth / 2;
  const containerCenterY = containerHeight / 2;

  globalState.translateX = containerCenterX - (graphCenterXInSVG * globalState.scale);
  globalState.translateY = containerCenterY - (graphCenterYInSVG * globalState.scale);

  applyTransform();

  // Debug log
  console.log('Center Graph:', {
    viewBox: {x: viewBoxX, y: viewBoxY, w: viewBoxWidth, h: viewBoxHeight},
    graphCenter: {x: graphCenterXInSVG, y: graphCenterYInSVG},
    containerCenter: {x: containerCenterX, y: containerCenterY},
    scale: globalState.scale,
    translate: {x: globalState.translateX, y: globalState.translateY}
  });
}

function applyTransform() {
  if (panZoomGroup) {
    panZoomGroup.setAttribute('transform',
      `translate(${globalState.translateX}, ${globalState.translateY}) scale(${globalState.scale})`
    );
  }
}

// Filters removed - graph shows all branches by default

function getBranchNameFromCommit(sha) {
  // Find the commit in our global commits array
  const commit = globalCommits.find(c => c.sha === sha);
  if (!commit) return null;

  // Use the origin_branch we computed (single branch based on column)
  return commit.origin_branch || null;
}

async function fetchLinkedIssues(sha) {
  try {
    // Search for issues that mention this commit SHA
    const response = await GET(`/api/v1/repos/${globalOwner}/${globalRepo}/issues?state=all&q=${sha}`);
    if (!response.ok) return [];
    const issues = await response.json();

    // Filter issues that actually contain the commit SHA in their body or comments
    return issues.filter(issue => {
      const bodyContainsSha = issue.body && issue.body.includes(sha);
      const titleContainsSha = issue.title && issue.title.includes(sha);
      return bodyContainsSha || titleContainsSha;
    });
  } catch (error) {
    console.error('Failed to fetch linked issues:', error);
    return [];
  }
}

async function openCommitPanel(sha) {
  const overlay = document.getElementById('commit-detail-overlay');
  const panel = document.getElementById('commit-detail-panel');
  const content = panel.querySelector('.panel-content');

  // Show panel and overlay
  overlay.classList.add('active');
  panel.classList.add('active');

  // Show loading
  content.innerHTML = '<div class="loading">Loading commit details...</div>';

  try {
    // Get branch name from commit data (synchronous lookup)
    const branchName = getBranchNameFromCommit(sha);

    // Fetch full commit details and linked issues in parallel
    const [commitResponse, linkedIssues] = await Promise.all([
      GET(`/api/v1/repos/${globalOwner}/${globalRepo}/git/commits/${sha}?stat=true&files=true`),
      fetchLinkedIssues(sha)
    ]);

    if (!commitResponse.ok) throw new Error(`HTTP ${commitResponse.status}`);
    const commit = await commitResponse.json();

    // Attach linked issues and branch to commit object
    commit.linked_issues = linkedIssues;
    commit.branch_name = branchName;

    // Update selected commit with actual branch name
    setSelectedCommit(sha, branchName);

    // Render commit details
    renderCommitDetails(content, commit);
  } catch (error) {
    console.error('Failed to load commit details:', error);
    content.innerHTML = `<div class="ui negative message">
      <div class="header">Failed to load commit details</div>
      <p>${escapeHTML(error.message)}</p>
    </div>`;
  }
}

function closeCommitPanel() {
  const overlay = document.getElementById('commit-detail-overlay');
  const panel = document.getElementById('commit-detail-panel');

  overlay.classList.remove('active');
  panel.classList.remove('active');
}

function setupPanelHandlers() {
  const overlay = document.getElementById('commit-detail-overlay');
  const closeBtn = document.querySelector('.close-panel');

  if (overlay) {
    overlay.addEventListener('click', closeCommitPanel);
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', closeCommitPanel);
  }
}

function renderCommitDetails(container, commit) {
  const sha = commit.sha;
  const message = commit.commit?.message || '';
  const author = commit.commit?.author || {};
  const committer = commit.commit?.committer || {};
  const stats = commit.stats || {};
  const files = commit.files || [];

  // Split message into title and body
  const messageParts = message.split('\n');
  const messageTitle = messageParts[0];
  const messageBody = messageParts.slice(1).join('\n').trim();

  // Build commit URL
  const commitUrl = `/${globalOwner}/${globalRepo}/commit/${sha}`;

  // Get linked issues
  const linkedIssues = commit.linked_issues || [];

  const html = `
    <div class="commit-section commit-message-section">
      <a href="${commitUrl}" class="commit-message-title-link" target="_blank">
        <div class="commit-message-title">${escapeHTML(messageTitle)}</div>
      </a>
      ${messageBody ? `<div class="commit-message-body">${escapeHTML(messageBody)}</div>` : ''}
    </div>

    <div class="commit-section commit-metadata">
      <div class="commit-author-info">
        <div class="commit-author-details">
          <span class="name">${escapeHTML(author.name || 'Unknown')}</span>
          <span class="date">${formatDate(author.date)}</span>
        </div>
      </div>
      <div class="commit-sha-line">
        <span class="sha-label">SHA:</span>
        <a href="${commitUrl}" class="commit-sha-link" target="_blank">
          <code class="commit-sha-code">${escapeHTML(sha)}</code>
        </a>
      </div>
      ${stats.total !== undefined ? `
        <div class="commit-stats-inline">
          <span class="stat-item">${stats.total || 0} files</span>
          <span class="stat-item additions">+${stats.additions || 0}</span>
          <span class="stat-item deletions">-${stats.deletions || 0}</span>
        </div>
      ` : ''}
      <button class="ui primary button create-issue-from-commit" data-sha="${escapeHTML(sha)}" style="margin-top: 16px; width: 100%;">
        <i class="exclamation icon"></i> Create Issue from this Commit
      </button>
    </div>

    ${linkedIssues.length > 0 ? `
      <div class="commit-section linked-issues-section">
        <h4><i class="exclamation circle icon"></i> Linked Issues (${linkedIssues.length})</h4>
        <div class="linked-issues-list">
          ${linkedIssues.map(issue => {
            const issueState = issue.state === 'closed' ? 'closed' : 'open';
            const issueStateIcon = issueState === 'closed' ? 'check circle' : 'circle outline';
            const issueStateColor = issueState === 'closed' ? 'var(--color-purple)' : 'var(--color-green)';
            const issueUrl = `/${globalOwner}/${globalRepo}/issues/${issue.number}`;
            return `
              <a href="${issueUrl}" class="linked-issue-item" target="_blank">
                <i class="${issueStateIcon} icon" style="color: ${issueStateColor};"></i>
                <div class="linked-issue-content">
                  <div class="linked-issue-title">
                    <span class="linked-issue-number">#${issue.number}</span>
                    ${escapeHTML(issue.title)}
                  </div>
                  <div class="linked-issue-meta">
                    ${issue.labels && issue.labels.length > 0 ? issue.labels.map(label =>
                      `<span class="linked-issue-label" style="background: #${label.color};">${escapeHTML(label.name)}</span>`
                    ).join('') : ''}
                  </div>
                </div>
              </a>
            `;
          }).join('')}
        </div>
      </div>
    ` : ''}

    <div class="commit-section commit-comments-section">
      <h4><i class="comment icon"></i> Notes</h4>
      <div class="commit-comments-container">
        <div class="commit-notes-textarea-wrapper">
          <textarea
            class="commit-notes-textarea"
            placeholder="Add notes about this commit..."
            rows="4"
            data-sha="${escapeHTML(sha)}"
          ></textarea>
          <button class="save-commit-notes" data-sha="${escapeHTML(sha)}" title="Save notes">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13.402 5.744a1.13 1.13 0 0 1 0 2.076L1.913 14.782a1.343 1.343 0 0 1-1.85-1.463L.99 8Zm.603-5.288L2.38 7.25h4.87a.75.75 0 0 1 0 1.5H2.38l-.788 4.538L13.929 8Z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    ${files.length > 0 ? `
      <div class="commit-section commit-files-section">
        <h4>Changed Files (${files.length})</h4>
        <div class="commit-files-list">
          ${files.map((file, index) => {
    const status = file.status || 'modified';
    const additions = file.additions || 0;
    const deletions = file.deletions || 0;
    return `
              <div class="file-item" data-file-index="${index}">
                <div class="file-header">
                  <span class="file-path" title="${escapeHTML(file.filename)}">${escapeHTML(file.filename)}</span>
                  <span class="file-changes">
                    <span class="additions">+${additions}</span>
                    <span class="deletions">-${deletions}</span>
                  </span>
                  <button class="view-diff-btn active" data-file="${escapeHTML(file.filename)}" data-sha="${escapeHTML(sha)}" title="Hide diff">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8.06 2C3 2 0 8 0 8s3 6 8.06 6C13 14 16 8 16 8s-3-6-7.94-6zM8 12c-2.2 0-4-1.78-4-4 0-2.2 1.8-4 4-4 2.22 0 4 1.8 4 4 0 2.22-1.78 4-4 4zm2-4c0 1.11-.89 2-2 2-1.11 0-2-.89-2-2 0-1.11.89-2 2-2 1.11 0 2 .89 2 2z"/>
                    </svg>
                  </button>
                </div>
                <div class="file-diff" data-file-index="${index}" style="display: block;">
                  <div class="diff-loading">Loading diff...</div>
                </div>
              </div>
            `;
  }).join('')}
        </div>
      </div>
    ` : ''}
  `;

  container.innerHTML = html;

  // Add event listeners for view diff buttons
  const diffButtons = container.querySelectorAll('.view-diff-btn');
  diffButtons.forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const filename = btn.getAttribute('data-file');
      const sha = btn.getAttribute('data-sha');
      const fileItem = btn.closest('.file-item');
      const fileIndex = fileItem.getAttribute('data-file-index');
      const diffContainer = fileItem.querySelector('.file-diff');

      // Toggle diff visibility
      if (diffContainer.style.display === 'none') {
        diffContainer.style.display = 'block';
        btn.classList.add('active');
        btn.setAttribute('title', 'Hide diff');

        // Load diff if not already loaded
        if (!diffContainer.hasAttribute('data-loaded')) {
          await loadFileDiff(sha, filename, diffContainer);
          diffContainer.setAttribute('data-loaded', 'true');
        }
      } else {
        diffContainer.style.display = 'none';
        btn.classList.remove('active');
        btn.setAttribute('title', 'View diff');
      }
    });
  });

  // Auto-load all diffs on panel open
  const allDiffContainers = container.querySelectorAll('.file-diff');
  allDiffContainers.forEach(async (diffContainer, index) => {
    const fileItem = diffContainer.closest('.file-item');
    const btn = fileItem.querySelector('.view-diff-btn');
    const filename = btn.getAttribute('data-file');
    const sha = btn.getAttribute('data-sha');

    // Load diff immediately
    await loadFileDiff(sha, filename, diffContainer);
    diffContainer.setAttribute('data-loaded', 'true');
  });

  // Add event listener for Create Issue button
  const createIssueBtn = container.querySelector('.create-issue-from-commit');
  if (createIssueBtn) {
    createIssueBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const commitSha = createIssueBtn.getAttribute('data-sha');
      // Branch name is already set from openCommitPanel
      await openCreateIssueModal();
    });
  }

  // Add event listener for Save Notes button
  const saveNotesBtn = container.querySelector('.save-commit-notes');
  if (saveNotesBtn) {
    saveNotesBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const textarea = container.querySelector('.commit-notes-textarea');
      const commitSha = saveNotesBtn.getAttribute('data-sha');
      const notes = textarea.value;

      // Store notes in localStorage (placeholder implementation)
      const storageKey = `commit-notes-${globalOwner}-${globalRepo}-${commitSha}`;
      localStorage.setItem(storageKey, notes);

      // Visual feedback
      const originalHTML = saveNotesBtn.innerHTML;
      saveNotesBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
        </svg>
      `;
      saveNotesBtn.style.background = 'rgba(74, 222, 128, 0.2)';
      saveNotesBtn.style.borderColor = 'rgba(74, 222, 128, 0.5)';
      saveNotesBtn.style.color = 'rgba(74, 222, 128, 1)';

      setTimeout(() => {
        saveNotesBtn.innerHTML = originalHTML;
        saveNotesBtn.style.background = '';
        saveNotesBtn.style.borderColor = '';
        saveNotesBtn.style.color = '';
      }, 2000);
    });
  }

  // Load existing notes from localStorage
  const textarea = container.querySelector('.commit-notes-textarea');
  if (textarea) {
    const commitSha = textarea.getAttribute('data-sha');
    const storageKey = `commit-notes-${globalOwner}-${globalRepo}-${commitSha}`;
    const savedNotes = localStorage.getItem(storageKey);
    if (savedNotes) {
      textarea.value = savedNotes;
    }
  }
}

async function loadFileDiff(sha, filename, container) {
  try {
    // Fetch the commit diff
    const response = await GET(`/api/v1/repos/${globalOwner}/${globalRepo}/git/commits/${sha}.diff`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const diffText = await response.text();

    // Parse and find the specific file's diff
    const fileDiff = extractFileDiff(diffText, filename);

    if (fileDiff) {
      renderDiff(fileDiff, container);
    } else {
      container.innerHTML = '<div class="diff-error">No diff available for this file</div>';
    }
  } catch (error) {
    console.error('Failed to load diff:', error);
    container.innerHTML = `<div class="diff-error">Failed to load diff: ${escapeHTML(error.message)}</div>`;
  }
}

function extractFileDiff(fullDiff, filename) {
  // Split by file headers (diff --git)
  const fileSections = fullDiff.split(/^diff --git /m);

  for (const section of fileSections) {
    if (section.includes(filename)) {
      return 'diff --git ' + section;
    }
  }

  return null;
}

function renderDiff(diffText, container) {
  const lines = diffText.split('\n');
  let html = '<div class="diff-view">';

  for (const line of lines) {
    let lineClass = 'diff-line';
    let lineContent = escapeHTML(line);

    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      lineClass += ' diff-header';
    } else if (line.startsWith('@@')) {
      lineClass += ' diff-hunk';
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      lineClass += ' diff-addition';
      // Remove the + prefix since we add it with CSS
      lineContent = escapeHTML(line.substring(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lineClass += ' diff-deletion';
      // Remove the - prefix since we add it with CSS
      lineContent = escapeHTML(line.substring(1));
    } else if (line.startsWith(' ')) {
      lineClass += ' diff-context';
      // Remove the leading space
      lineContent = escapeHTML(line.substring(1));
    }

    html += `<div class="${lineClass}"><code>${lineContent}</code></div>`;
  }

  html += '</div>';
  container.innerHTML = html;
}

function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleString();
}
