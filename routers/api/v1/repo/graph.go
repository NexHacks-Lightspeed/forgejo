// Copyright 2025 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: MIT

package repo

import (
	"bufio"
	"net/http"
	"regexp"
	"strings"

	"forgejo.org/modules/git"
	api "forgejo.org/modules/structs"
	"forgejo.org/services/context"
)

var (
	// Regex to extract commit SHA from git log --graph output
	commitSHARegex = regexp.MustCompile(`commit ([0-9a-f]{40})`)
)

// GetCommitGraph returns the commit graph data for visualization
func GetCommitGraph(ctx *context.APIContext) {
	// swagger:operation GET /repos/{owner}/{repo}/graph repository repoGetCommitGraph
	// ---
	// summary: Get commit graph data for visualization
	// produces:
	// - application/json
	// parameters:
	// - name: owner
	//   in: path
	//   description: owner of the repo
	//   type: string
	//   required: true
	// - name: repo
	//   in: path
	//   description: name of the repo
	//   type: string
	//   required: true
	// - name: page
	//   in: query
	//   description: page number of results to return (1-based)
	//   type: integer
	// - name: limit
	//   in: query
	//   description: page size of results
	//   type: integer
	// responses:
	//   "200":
	//     description: success
	//   "404":
	//     description: repository not found

	page := ctx.FormInt("page")
	if page <= 0 {
		page = 1
	}

	limit := ctx.FormInt("limit")
	if limit <= 0 {
		limit = 100
	}
	if limit > 200 {
		limit = 200
	}

	gitRepo := ctx.Repo.GitRepo
	if gitRepo == nil {
		ctx.Error(http.StatusInternalServerError, "GetCommitGraph", "GitRepo is nil")
		return
	}

	// Run git log --graph --all --format to get graph structure
	skip := (page - 1) * limit
	cmd := git.NewCommand(ctx, "log", "--graph", "--all", "--color=never",
		"--pretty=format:commit %H|%h|%s|%an|%ae|%cn|%ce|%at|%P",
		"--date-order").
		AddOptionFormat("--skip=%d", skip).
		AddOptionFormat("--max-count=%d", limit)

	stdout, _, err := cmd.RunStdString(&git.RunOpts{Dir: gitRepo.Path})
	if err != nil {
		ctx.Error(http.StatusInternalServerError, "git log", err)
		return
	}

	// Parse the graph output
	commits, flows, bounds := parseGitGraph(stdout)

	response := api.GitGraph{
		Commits: commits,
		Flows:   flows,
		Bounds:  bounds,
	}

	ctx.JSON(http.StatusOK, response)
}

// parseGitGraph parses git log --graph output into structured data
func parseGitGraph(output string) ([]api.GitGraphCommit, []api.GitGraphFlow, api.GitGraphBounds) {
	commits := make([]api.GitGraphCommit, 0)
	flows := make(map[int]api.GitGraphFlow)
	flowCounter := 0
	columnToFlow := make(map[int]int)

	scanner := bufio.NewScanner(strings.NewReader(output))
	row := 0
	minCol, maxCol := 999999, 0

	for scanner.Scan() {
		line := scanner.Text()
		if len(line) == 0 {
			continue
		}

		// Parse the graph part (before the commit data)
		graphEnd := strings.Index(line, "commit ")
		if graphEnd == -1 {
			// Skip lines without commit data (just graph lines)
			continue
		}

		graphPart := line[:graphEnd]
		commitData := line[graphEnd:]

		// Extract commit information
		matches := commitSHARegex.FindStringSubmatch(commitData)
		if len(matches) < 2 {
			continue
		}

		// Parse commit data: SHA|shortSHA|message|author|authorEmail|committer|committerEmail|timestamp|parents
		parts := strings.SplitN(strings.TrimPrefix(commitData, "commit "), "|", 9)
		if len(parts) < 8 {
			continue
		}

		sha := parts[0]
		shortSHA := parts[1]
		message := parts[2]
		authorName := parts[3]
		authorEmail := parts[4]
		committerName := parts[5]
		committerEmail := parts[6]
		// timestamp := parts[7] // Unix timestamp
		parentsStr := ""
		if len(parts) > 8 {
			parentsStr = parts[8]
		}

		parents := make([]string, 0)
		if parentsStr != "" {
			parents = strings.Split(parentsStr, " ")
		}

		// Parse glyphs from the graph part
		glyphs := make([]api.GitGraphGlyph, 0)
		column := -1
		flowID := -1

		for col, ch := range graphPart {
			glyphType := ""
			switch ch {
			case '*':
				glyphType = "*"
				column = col
				// Assign or create flow for this commit
				if fID, exists := columnToFlow[col]; exists {
					flowID = fID
				} else {
					flowID = flowCounter
					columnToFlow[col] = flowID
					flows[flowID] = api.GitGraphFlow{
						ID:    flowID,
						Color: flowID % 16,
					}
					flowCounter++
				}
			case '|':
				glyphType = "|"
			case '/':
				glyphType = "/"
			case '\\':
				glyphType = "\\"
			case '-', '_':
				glyphType = string(ch)
			case ' ':
				continue
			default:
				continue
			}

			if glyphType != "" {
				gFlowID := flowID
				if gFlowID == -1 {
					if fID, exists := columnToFlow[col]; exists {
						gFlowID = fID
					}
				}
				glyphs = append(glyphs, api.GitGraphGlyph{
					Type:   glyphType,
					Column: col,
					FlowID: gFlowID,
				})
			}
		}

		// If column wasn't set (no * found), use the first glyph column
		if column == -1 && len(glyphs) > 0 {
			column = glyphs[0].Column
		}

		// Update bounds
		if column < minCol {
			minCol = column
		}
		if column > maxCol {
			maxCol = column
		}

		commit := api.GitGraphCommit{
			SHA:      sha,
			ShortSHA: shortSHA,
			Message:  message,
			Author: &api.CommitUser{
				Identity: api.Identity{
					Name:  authorName,
					Email: authorEmail,
				},
			},
			Committer: &api.CommitUser{
				Identity: api.Identity{
					Name:  committerName,
					Email: committerEmail,
				},
			},
			Parents: parents,
			Row:     row,
			Column:  column,
			Glyphs:  glyphs,
			FlowID:  flowID,
		}

		commits = append(commits, commit)
		row++
	}

	// Convert flows map to slice
	flowSlice := make([]api.GitGraphFlow, 0, len(flows))
	for _, flow := range flows {
		flowSlice = append(flowSlice, flow)
	}

	bounds := api.GitGraphBounds{
		MinRow:    0,
		MaxRow:    row - 1,
		MinColumn: minCol,
		MaxColumn: maxCol,
	}

	return commits, flowSlice, bounds
}
