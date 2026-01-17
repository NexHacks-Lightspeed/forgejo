// Copyright 2025 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: MIT

package structs

import "time"

// GitGraph represents the response for the git graph API
type GitGraph struct {
	Commits []GitGraphCommit `json:"commits"`
	Flows   []GitGraphFlow   `json:"flows"`
	Bounds  GitGraphBounds   `json:"bounds"`
}

// GitGraphCommit represents a commit in the git graph
type GitGraphCommit struct {
	SHA       string              `json:"sha"`
	ShortSHA  string              `json:"short_sha"`
	Message   string              `json:"message"`
	Author    *CommitUser         `json:"author"`
	Committer *CommitUser         `json:"committer"`
	Timestamp time.Time           `json:"timestamp"`
	Parents   []string            `json:"parents"`
	Row       int                 `json:"row"`
	Column    int                 `json:"column"`
	Glyphs    []GitGraphGlyph     `json:"glyphs"`
	Refs      []string            `json:"refs,omitempty"`
	FlowID    int                 `json:"flow_id"`
}

// GitGraphGlyph represents a visual glyph in the graph
type GitGraphGlyph struct {
	Type   string `json:"type"`   // "|", "*", "/", "\", "-", "_"
	Column int    `json:"column"` // column position
	FlowID int    `json:"flow_id"`
}

// GitGraphFlow represents a branch/flow in the graph
type GitGraphFlow struct {
	ID    int    `json:"id"`
	Color int    `json:"color"` // color index (0-15)
	Name  string `json:"name,omitempty"`
}

// GitGraphBounds represents the dimensions of the graph
type GitGraphBounds struct {
	MinRow    int `json:"min_row"`
	MaxRow    int `json:"max_row"`
	MinColumn int `json:"min_column"`
	MaxColumn int `json:"max_column"`
}
