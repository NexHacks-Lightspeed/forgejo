// Copyright 2024 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: MIT

package repo

import (
	"net/http"

	"forgejo.org/modules/base"
	"forgejo.org/services/context"
)

const (
	tplDevTree base.TplName = "repo/devtree"
)

// DevTree shows the interactive git commit graph
func DevTree(ctx *context.Context) {
	ctx.Data["Title"] = ctx.Tr("repo.devtree")
	ctx.Data["PageIsDevTree"] = true

	if ctx.Repo.Repository.IsEmpty {
		ctx.Data["IsEmptyRepo"] = true
	}

	ctx.HTML(http.StatusOK, tplDevTree)
}
