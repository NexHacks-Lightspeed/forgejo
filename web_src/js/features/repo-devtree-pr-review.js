import {GET, POST} from '../modules/fetch.js';
import {showErrorToast, showInfoToast} from '../modules/toast.js';

let globalOwner = null;
let globalRepo = null;

export function initPRReview(owner, repo) {
  globalOwner = owner;
  globalRepo = repo;
  setupPanelHandlers();
}

function setupPanelHandlers() {
  const overlay = document.getElementById('pr-review-overlay');
  const closeBtn = document.querySelector('#pr-review-panel .close-panel');

  if (overlay) {
    overlay.addEventListener('click', closePRPanel);
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', closePRPanel);
  }
}

export async function openPRReviewPanel(prNumber) {
  const overlay = document.getElementById('pr-review-overlay');
  const panel = document.getElementById('pr-review-panel');
  const content = panel.querySelector('.panel-content');

  // Show panel and overlay
  overlay.classList.add('active');
  panel.classList.add('active');

  // Show loading
  content.innerHTML = '<div class="loading">Loading PR details...</div>';

  try {
    // Fetch PR details
    const prResponse = await GET(`/api/v1/repos/${globalOwner}/${globalRepo}/pulls/${prNumber}`);
    if (!prResponse.ok) throw new Error(`HTTP ${prResponse.status}`);
    const pr = await prResponse.json();

    // Fetch commits
    const commitsResponse = await GET(`/api/v1/repos/${globalOwner}/${globalRepo}/pulls/${prNumber}/commits`);
    const commits = commitsResponse.ok ? await commitsResponse.json() : [];

    // Fetch reviews
    const reviewsResponse = await GET(`/api/v1/repos/${globalOwner}/${globalRepo}/pulls/${prNumber}/reviews`);
    const reviews = reviewsResponse.ok ? await reviewsResponse.json() : [];

    // Render PR details
    renderPRDetails(content, pr, commits, reviews);
  } catch (error) {
    console.error('Failed to load PR details:', error);
    content.innerHTML = `<div class="ui negative message">
      <div class="header">Failed to load PR details</div>
      <p>${escapeHTML(error.message)}</p>
    </div>`;
  }
}

function closePRPanel() {
  const overlay = document.getElementById('pr-review-overlay');
  const panel = document.getElementById('pr-review-panel');

  overlay.classList.remove('active');
  panel.classList.remove('active');
}

function renderPRDetails(container, pr, commits, reviews) {
  const stateClass = pr.merged ? 'merged' : pr.state;
  const stateText = pr.merged ? 'Merged' : (pr.state === 'open' ? 'Open' : 'Closed');

  let html = `
    <div class="pr-review-section">
      <div class="pr-title">${escapeHTML(pr.title)}</div>
      <div class="pr-number">#${pr.number} <span class="pr-state ${stateClass}">${stateText}</span></div>
    </div>

    <div class="pr-review-section">
      <h4>Details</h4>
      <div class="pr-meta-line"><strong>Author:</strong> ${escapeHTML(pr.user?.login || 'Unknown')}</div>
      <div class="pr-meta-line"><strong>Created:</strong> ${formatDate(pr.created_at)}</div>
      <div class="pr-meta-line"><strong>Updated:</strong> ${formatDate(pr.updated_at)}</div>
      ${pr.merged_at ? `<div class="pr-meta-line"><strong>Merged:</strong> ${formatDate(pr.merged_at)}</div>` : ''}
      <div class="pr-meta-line"><strong>Base:</strong> <code>${escapeHTML(pr.base?.ref || 'unknown')}</code></div>
      <div class="pr-meta-line"><strong>Head:</strong> <code>${escapeHTML(pr.head?.ref || 'unknown')}</code></div>
    </div>
  `;

  if (pr.body) {
    html += `
      <div class="pr-review-section">
        <h4>Description</h4>
        <div style="white-space: pre-wrap; color: rgba(255, 255, 255, 0.8); font-size: 13px;">${escapeHTML(pr.body)}</div>
      </div>
    `;
  }

  // Commits section
  if (commits && commits.length > 0) {
    html += `
      <div class="pr-review-section">
        <h4>Commits (${commits.length})</h4>
        <ul class="pr-commit-list">
          ${commits.map((commit) => `
            <li class="pr-commit-item">
              <span class="pr-commit-sha">${commit.sha ? commit.sha.substring(0, 7) : 'unknown'}</span>
              ${escapeHTML(commit.commit?.message?.split('\n')[0] || 'No message')}
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  }

  // Changed files section
  if (pr.changed_files > 0) {
    html += `
      <div class="pr-review-section">
        <h4>Changes</h4>
        <div class="pr-meta-line">
          <strong>${pr.changed_files}</strong> files changed,
          <strong style="color: #4ade80;">+${pr.additions}</strong> additions,
          <strong style="color: #fb7185;">-${pr.deletions}</strong> deletions
        </div>
      </div>
    `;
  }

  // Reviews section
  if (reviews && reviews.length > 0) {
    html += `
      <div class="pr-review-section">
        <h4>Reviews (${reviews.length})</h4>
        ${reviews.map((review) => `
          <div style="padding: 10px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.08); margin-bottom: 8px;">
            <div style="font-weight: 600; color: rgba(255, 255, 255, 0.9); margin-bottom: 4px;">
              ${escapeHTML(review.user?.login || 'Unknown')}
              <span style="margin-left: 8px; padding: 2px 8px; border-radius: 8px; font-size: 11px; font-weight: 600;
                ${review.state === 'APPROVED' ? 'background: rgba(34, 197, 94, 0.2); color: #4ade80;' : ''}
                ${review.state === 'CHANGES_REQUESTED' ? 'background: rgba(239, 68, 68, 0.2); color: #fb7185;' : ''}
                ${review.state === 'COMMENTED' ? 'background: rgba(156, 163, 175, 0.2); color: #9ca3af;' : ''}
              ">${review.state}</span>
            </div>
            ${review.body ? `<div style="font-size: 12px; color: rgba(255, 255, 255, 0.7);">${escapeHTML(review.body)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // Actions section (only show if PR is open)
  if (pr.state === 'open') {
    html += `
      <div class="pr-review-section">
        <h4>Review Actions</h4>
        <div class="pr-review-comment-form">
          <textarea id="pr-review-comment" placeholder="Add your review comment (optional)..."></textarea>
        </div>
        <div class="pr-review-actions">
          <button class="ui green button" data-action="approve" data-pr="${pr.number}">
            <i class="check icon"></i> Approve
          </button>
          <button class="ui yellow button" data-action="comment" data-pr="${pr.number}">
            <i class="comment icon"></i> Comment
          </button>
          <button class="ui red button" data-action="request-changes" data-pr="${pr.number}">
            <i class="times icon"></i> Request Changes
          </button>
        </div>
        ${pr.mergeable ? `
          <div class="pr-review-actions" style="margin-top: 20px; padding-top: 20px; border-top: 1px solid rgba(255, 255, 255, 0.1);">
            <button class="ui purple button" data-action="merge" data-pr="${pr.number}" style="flex: none; width: 100%;">
              <i class="code branch icon"></i> Merge Pull Request
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  container.innerHTML = html;

  // Attach event listeners to action buttons
  container.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', handlePRAction);
  });
}

async function handlePRAction(e) {
  const action = e.currentTarget.getAttribute('data-action');
  const prNumber = e.currentTarget.getAttribute('data-pr');
  const commentTextarea = document.getElementById('pr-review-comment');
  const comment = commentTextarea ? commentTextarea.value.trim() : '';

  e.currentTarget.classList.add('loading');

  try {
    if (action === 'approve' || action === 'comment' || action === 'request-changes') {
      await submitReview(prNumber, action, comment);
    } else if (action === 'merge') {
      await mergePR(prNumber);
    }

    // Reload PR details
    setTimeout(() => {
      openPRReviewPanel(prNumber);
    }, 500);
  } catch (error) {
    console.error(`Error performing ${action}:`, error);
    showErrorToast(error.message);
    e.currentTarget.classList.remove('loading');
  }
}

async function submitReview(prNumber, action, comment) {
  const eventMap = {
    'approve': 'APPROVE',
    'comment': 'COMMENT',
    'request-changes': 'REQUEST_CHANGES',
  };

  const reviewData = {
    event: eventMap[action],
  };

  if (comment) {
    reviewData.body = comment;
  }

  const response = await POST(`/api/v1/repos/${globalOwner}/${globalRepo}/pulls/${prNumber}/reviews`, {
    data: reviewData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `Failed to ${action} PR`);
  }

  const actionText = action === 'approve' ? 'approved' : (action === 'request-changes' ? 'requested changes' : 'commented on');
  showInfoToast(`Successfully ${actionText} PR #${prNumber}`);
}

async function mergePR(prNumber) {
  const mergeData = {
    Do: 'merge', // or 'rebase', 'squash'
  };

  const response = await POST(`/api/v1/repos/${globalOwner}/${globalRepo}/pulls/${prNumber}/merge`, {
    data: mergeData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to merge PR');
  }

  showInfoToast(`Successfully merged PR #${prNumber}`);

  // Close panel after merge
  setTimeout(() => {
    closePRPanel();
  }, 2000);
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
