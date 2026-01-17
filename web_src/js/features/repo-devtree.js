import {GET} from '../modules/fetch.js';
import {showErrorToast} from '../modules/toast.js';
import $ from 'jquery';
import {initDevTreeAgent, setSelectedCommit, openCreateIssueModal} from './repo-devtree-agent.js';
import {initPRReview, openPRReviewPanel} from './repo-devtree-pr-review.js';
import {initDevControls} from './repo-devtree-dev-controls.js';

// Branch color palette (from gitgraph.css) - 16 colors
const BRANCH_COLORS = [
  '#7db233', '#499a37', '#ce4751', '#8f9121', '#ac32a6', '#7445e9',
  '#c67d28', '#4db392', '#aa4d30', '#2a6f84', '#c45327', '#3d965c',
  '#792a93', '#439d73', '#103aad', '#982e85',
];

const BRANCH_COLORS_HIGHLIGHT = [
  '#87ca28', '#5ac144', '#ed5a8b', '#ced049', '#db61d7', '#8455f9',
  '#e6a151', '#44daaa', '#dd7a5c', '#38859c', '#d95520', '#42ae68',
  '#9126b5', '#4ab080', '#284fb8', '#971c80',
];

// Layout dimensions (Railway-style card nodes)
const COLUMN_SPACING = 200;  // Wide spacing for card nodes
const ROW_SPACING = 70;      // Vertical spacing for cards
const CARD_WIDTH = 180;      // Card width
const CARD_HEIGHT = 60;      // Card height
const CARD_RADIUS = 8;       // Card corner radius
const COMMIT_RADIUS = 8;     // Fallback circle size
const STROKE_WIDTH = 2.5;    // Path stroke width

// Pan/zoom constants
const DEFAULT_SCALE = 1.0;
const MIN_SCALE = 0.3;
const MAX_SCALE = 3.0;
const ZOOM_SPEED = 0.15;
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

  if (isMerge) cardGroup.classList.add('merge-commit');
  if (isTagged) cardGroup.classList.add('tagged-commit');

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

  return cardGroup;
}

async function loadCommitGraph(owner, repo, container) {
  const loading = document.getElementById('loading');
  const errorDiv = document.getElementById('error');
  const graphContainer = document.getElementById('devtree-graph-container');

  try {
    const graphData = await fetchGraphData(owner, repo, 1);
    renderGraph(graphContainer, graphData, owner, repo);
    loading.style.display = 'none';
  } catch (error) {
    console.error('Failed to load commit graph:', error);
    loading.style.display = 'none';
    errorDiv.style.display = 'block';
    document.getElementById('error-text').textContent = error.message;
    showErrorToast(`Failed to load commit graph: ${error.message}`);
  }
}

function renderGraph(container, graphData, owner, repo) {
  const commits = graphData.commits;
  if (!commits || commits.length === 0) {
    container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--color-text-light);">No commits to display</div>';
    return;
  }

  // Calculate dimensions
  const minRow = Math.min(...commits.map((c) => c.row));
  const maxRow = Math.max(...commits.map((c) => c.row));
  const minColumn = Math.min(...commits.map((c) => c.column));
  const maxColumn = Math.max(...commits.map((c) => c.column));

  // Build flow color map from API data
  const flows = graphData.flows || [];
  const flowColorMap = new Map();
  flows.forEach(flow => {
    flowColorMap.set(flow.id, flow.color);
  });

  // Build commit map for parent lookups
  const commitMap = new Map();
  commits.forEach((commit) => {
    commitMap.set(commit.sha, commit);
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

  // Draw flows - separate paths and circles for proper layering
  const pathsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  pathsGroup.setAttribute('class', 'paths-layer');
  const circlesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  circlesGroup.setAttribute('class', 'circles-layer');

  // Default gray color for cross-branch edges
  const CROSS_BRANCH_COLOR = 'rgba(255, 255, 255, 0.3)';

  // Track drawn edges to avoid duplicates
  const drawnEdges = new Set();

  // Draw all edges
  commits.forEach((commit) => {
    const x = commit.column * COLUMN_SPACING + COLUMN_SPACING;
    const y = commit.row * ROW_SPACING + (ROW_SPACING / 2);
    const commitFlowId = commit.flow_id;
    const commitColor = flowColorMap.get(commitFlowId) || 0;

    // Draw connections to parents
    const parents = commit.parents || [];
    parents.forEach((parentSha) => {
      const parent = commitMap.get(parentSha);
      if (!parent) return;

      // Create unique edge key to prevent duplicates
      const edgeKey = `${commit.sha}-${parentSha}`;
      if (drawnEdges.has(edgeKey)) return;
      drawnEdges.add(edgeKey);

      const parentX = parent.column * COLUMN_SPACING + COLUMN_SPACING;
      const parentY = parent.row * ROW_SPACING + (ROW_SPACING / 2);
      const parentFlowId = parent.flow_id;
      const parentColor = flowColorMap.get(parentFlowId) || 0;

      // Determine edge color: use commit's color for its outgoing edge to parent
      const edgeColor = getBranchColor(commitColor);

      // Generate path based on relationship - linear with rounded corners
      let pathData;

      // Start from bottom center of commit card
      const startY = y + CARD_HEIGHT / 2;
      // End at top center of parent card
      const endY = parentY - CARD_HEIGHT / 2;

      if (x === parentX) {
        // Same column - straight vertical line
        pathData = `M ${x} ${startY} L ${parentX} ${endY}`;
      } else {
        // Different columns - linear path with rounded corners
        const dx = parentX - x;
        const dy = endY - startY;

        // Define corner radius for smooth turns
        const cornerRadius = Math.min(20, Math.abs(dx) / 2, Math.abs(dy) / 4);

        // Calculate midpoint for horizontal segment
        const midY = startY + dy / 2;

        if (dx > 0) {
          // Parent is to the right
          pathData = `
            M ${x} ${startY}
            L ${x} ${midY - cornerRadius}
            Q ${x} ${midY}, ${x + cornerRadius} ${midY}
            L ${parentX - cornerRadius} ${midY}
            Q ${parentX} ${midY}, ${parentX} ${midY + cornerRadius}
            L ${parentX} ${endY}
          `;
        } else {
          // Parent is to the left
          pathData = `
            M ${x} ${startY}
            L ${x} ${midY - cornerRadius}
            Q ${x} ${midY}, ${x - cornerRadius} ${midY}
            L ${parentX + cornerRadius} ${midY}
            Q ${parentX} ${midY}, ${parentX} ${midY + cornerRadius}
            L ${parentX} ${endY}
          `;
        }
      }

      // Create individual path for this edge
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData.replace(/\s+/g, ' ').trim());
      path.setAttribute('stroke', edgeColor);
      path.setAttribute('stroke-width', STROKE_WIDTH);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('opacity', '0.7');
      pathsGroup.appendChild(path);
    });
  });

  // Draw commit cards
  commits.forEach((commit) => {
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
        openCommitPanel(commit.sha);
        setSelectedCommit(commit.sha);
      }
    });

    circlesGroup.appendChild(card);
  });

  // Add layers in order: paths first, then circles on top
  panZoomGroup.appendChild(pathsGroup);
  panZoomGroup.appendChild(circlesGroup);

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
    // Fetch full commit details
    const response = await GET(`/api/v1/repos/${globalOwner}/${globalRepo}/git/commits/${sha}?stat=true&files=true`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const commit = await response.json();

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

  const html = `
    <div class="commit-section commit-metadata">
      <div class="commit-author-info">
        <img src="${escapeHTML(commit.author?.avatar_url || '')}" alt="${escapeHTML(author.name || 'Unknown')}">
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

    <div class="commit-section commit-message-section">
      <a href="${commitUrl}" class="commit-message-title-link" target="_blank">
        <div class="commit-message-title">${escapeHTML(messageTitle)}</div>
      </a>
      ${messageBody ? `<div class="commit-message-body">${escapeHTML(messageBody)}</div>` : ''}
    </div>

    ${files.length > 0 ? `
      <div class="commit-section commit-files-section">
        <h4>Changed Files (${files.length})</h4>
        <div class="commit-files-list">
          ${files.map((file, index) => {
    const status = file.status || 'modified';
    const statusLabel = status === 'added' ? 'A' : status === 'deleted' ? 'D' : 'M';
    const additions = file.additions || 0;
    const deletions = file.deletions || 0;
    return `
              <div class="file-item" data-file-index="${index}">
                <div class="file-header">
                  <span class="file-status ${status}">${statusLabel}</span>
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
      setSelectedCommit(commitSha);
      await openCreateIssueModal();
    });
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

function escapeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
