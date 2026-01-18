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

  return cardGroup;
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

  return {
    commits,
    commitMap,
    children,
    commitToBranches
  };
}

async function renderGraph(container, graphData, owner, repo) {
  const commits = graphData.commits;
  if (!commits || commits.length === 0) {
    container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--color-text-light);">No commits to display</div>';
    return;
  }

  // Store data globally for branch lookups
  globalFlows = graphData.flows || [];

  // Show loading indicator while fetching branch data
  container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--color-text-light);"><div class="ui active centered inline loader"></div><p style="margin-top: 20px;">Loading branch affiliations...</p></div>';

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
    });
  });

  // Draw commit cards
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

    circlesGroup.appendChild(card);
  });

  // Draw branch boundaries (column-based origin grouping)
  drawBranchBoundaries(orderedCommits, branchBoundariesGroup);

  // Add layers in order: boundaries first, then paths, then circles on top
  panZoomGroup.appendChild(branchBoundariesGroup);
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
        <textarea
          class="commit-notes-textarea"
          placeholder="Add notes about this commit..."
          rows="4"
          data-sha="${escapeHTML(sha)}"
        ></textarea>
        <div class="commit-notes-actions">
          <button class="save-commit-notes" data-sha="${escapeHTML(sha)}">
            <i class="save icon"></i> Save Notes
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
      saveNotesBtn.innerHTML = '<i class="check icon"></i> Saved';
      saveNotesBtn.style.background = 'rgba(74, 222, 128, 0.2)';
      saveNotesBtn.style.color = '#6ee7b7';

      setTimeout(() => {
        saveNotesBtn.innerHTML = '<i class="save icon"></i> Save Notes';
        saveNotesBtn.style.background = '';
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

function escapeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
