/**
 * Route handlers for GET/POST /api/personas, GET /api/random-name and
 * DELETE /api/personas/:id, extracted out of server/index.mjs so they are
 * importable (and therefore testable) without triggering index.mjs's
 * module-scope side effects — index.mjs constructs real singletons
 * (OpenCodeServerPool, loaded personas.json, migrations, app.listen) at
 * import time, which is exactly why "0% line coverage across 2,038 lines"
 * was the measured state before this split (symposion#39 / policy T1-1).
 *
 * This module has NO top-level side effects of its own: importing it only
 * defines createPersonasRouter. Every collaborator it needs (the live
 * personas Map, the OpenCode pool, validation tables, etc.) is passed in via
 * `ctx`, built once in index.mjs and handed to this factory — the same
 * functions index.mjs already used, just no longer inlined into the route
 * definitions. Behaviour is unchanged; only where the code lives changed.
 */
import express from "express";

/**
 * @param {object} ctx
 * @param {Map<string, object>} ctx.personas
 * @param {object} ctx.fs - node:fs (or a stand-in for tests)
 * @param {object} ctx.path - node:path
 * @param {(raw: string, fallback: string) => string} ctx.resolveWorkspaceDir
 * @param {(dir: string) => boolean} ctx.isWorkspaceAllowed
 * @param {(dir: string) => string} ctx.workspaceRejectionMessage
 * @param {string} ctx.DEFAULT_WORKSPACE
 * @param {string[]} ctx.MODEL_GROUP_KEYS
 * @param {(group: string) => object|null} ctx.resolveModelGroup
 * @param {(modelID: string) => boolean} ctx.isValidClaudeModel
 * @param {Array} ctx.CLAUDE_MODELS
 * @param {Array} ctx.CLAUDE_PERMISSION_MODES
 * @param {Array} ctx.CLAUDE_EFFORT_LEVELS
 * @param {(recipe: object) => Promise<object>} ctx.createPersonaFromRecipe
 * @param {(p: object) => object} ctx.personaSummary
 * @param {(existingNames: string[]) => string} ctx.randomStarName
 * @param {(pid: number) => void} ctx.stopRemoteControl
 * @param {(repoDir: string, worktreePath: string, branch: string, context: object) => void} ctx.removeWorktreeAndBranch
 * @param {(persona: object) => Promise<void>} ctx.ensureConnected
 * @param {(personaId: string) => void} ctx.removeArchives
 * @param {() => void} ctx.persistAll
 */
export function createPersonasRouter(ctx) {
  const router = express.Router();

  /**
   * A fresh random star name, excluding names already in use by a live
   * persona - backs the "New Agent" modal's auto-filled name field and its
   * dice/regenerate button, so nobody has to type a name to create a persona.
   */
  router.get("/api/random-name", (req, res) => {
    res.json({ name: ctx.randomStarName([...ctx.personas.values()].map((p) => p.name)) });
  });

  router.get("/api/personas", (req, res) => {
    res.json([...ctx.personas.values()].map(ctx.personaSummary));
  });

  router.post("/api/personas", async (req, res) => {
    try {
      let { backend, providerID, modelID, modelGroup, permissionMode, effortLevel } = req.body ?? {};
      // A name is never required to create a persona - an untyped/blank field
      // just gets a random star name, excluding whatever's already in use.
      const name = (req.body?.name ?? "").trim() || ctx.randomStarName([...ctx.personas.values()].map((p) => p.name));
      const workspaceDir = ctx.resolveWorkspaceDir(req.body?.workspaceDir, ctx.DEFAULT_WORKSPACE);
      // The authorization the old resolver never did. This value flows into
      // `git worktree add -b` with `cwd` set to it, so an unconstrained one lets
      // this endpoint create a branch in any repo on the machine and run git
      // anywhere - CodeQL alerts #42/#43/#44, symposion-I110. Enforced HERE, at
      // the point of creation, and deliberately NOT on reconnect: an existing
      // persona's worktree already exists, and re-checking it on every restart
      // would strand personas created before this rule rather than protect
      // anything that has not already happened.
      if (!ctx.isWorkspaceAllowed(workspaceDir)) {
        return res.status(400).json({ error: ctx.workspaceRejectionMessage(workspaceDir) });
      }
      if (backend !== "api" && backend !== "claude-code") {
        return res.status(400).json({ error: 'backend must be "api" or "claude-code"' });
      }

      // Resolve modelGroup → concrete providerID/modelID via krepis router.
      // Group wins over any separately provided providerID/modelID.
      if (modelGroup) {
        // Capability classes are an api-backend concept: the router owns what a
        // class means. The claude-code backend shells out to `claude -p --model
        // <id>`, which takes a concrete model and answers an unknown one with a
        // 404 wearing an assistant message - so resolving a class here would
        // hand the CLI the literal string "high" (symposion-I96).
        if (backend === "claude-code") {
          return res.status(400).json({ error: "modelGroup is api-backend only - claude-code personas take a concrete modelID from GET /api/claude-models" });
        }
        if (!ctx.MODEL_GROUP_KEYS.includes(modelGroup)) {
          return res.status(400).json({ error: `unrecognized modelGroup: ${modelGroup}. Valid: ${ctx.MODEL_GROUP_KEYS.join(", ")}` });
        }
        const resolved = ctx.resolveModelGroup(modelGroup);
        if (!resolved) {
          return res.status(503).json({ error: `modelGroup ${modelGroup} is not currently available (krepis resolution pending or failed)` });
        }
        providerID = resolved.providerID;
        modelID = resolved.modelID;
      }

      if (!modelID && !modelGroup) return res.status(400).json({ error: "modelID or modelGroup is required" });
      if (backend === "claude-code" && !ctx.isValidClaudeModel(modelID)) {
        return res.status(400).json({ error: `unrecognized claude-code modelID: ${JSON.stringify(modelID)}. Valid: ${ctx.CLAUDE_MODELS.map((m) => m.modelID).join(", ")}` });
      }
      if (permissionMode && !ctx.CLAUDE_PERMISSION_MODES.some((m) => m.value === permissionMode)) {
        return res.status(400).json({ error: `unrecognized permissionMode: ${permissionMode}` });
      }
      if (effortLevel && !ctx.CLAUDE_EFFORT_LEVELS.some((m) => m.value === effortLevel)) {
        return res.status(400).json({ error: `unrecognized effortLevel: ${effortLevel}` });
      }
      if (!ctx.path.isAbsolute(workspaceDir)) {
        return res.status(400).json({ error: `workspaceDir must be an absolute path (or start with ~): ${req.body?.workspaceDir}` });
      }
      if (!ctx.fs.existsSync(workspaceDir)) {
        return res.status(400).json({ error: `workspaceDir does not exist: ${workspaceDir}` });
      }
      if (!ctx.fs.statSync(workspaceDir).isDirectory()) {
        return res.status(400).json({ error: `workspaceDir is not a directory: ${workspaceDir}` });
      }
      if (backend === "api" && !providerID) {
        return res.status(400).json({ error: "providerID is required for backend=api" });
      }

      const persona = await ctx.createPersonaFromRecipe({ backend, providerID, modelID, modelGroup, permissionMode, effortLevel, workspaceDir, name });
      res.status(201).json(ctx.personaSummary(persona));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * Full wind-down, not just a UI hide: stop the actual backend process/
   * session so nothing keeps running or billing after deletion, and clean up
   * every artifact this persona created (worktree, branch, OpenCode session)
   * rather than leaving them orphaned.
   */
  router.delete("/api/personas/:id", async (req, res) => {
    const persona = ctx.personas.get(req.params.id);
    if (!persona) return res.status(404).json({ error: "not found" });

    if (persona.backend === "claude-code") {
      persona.claudeSession?.kill();
      // A handed-off persona's live process is the detached remote-control
      // pair, not claudeSession - kill it too or deleting the persona would
      // leave a phone-controllable session running in a just-removed worktree.
      if (persona.handoff) ctx.stopRemoteControl(persona.handoff.pid);
      if (persona.isolated) {
        ctx.removeWorktreeAndBranch(persona.workspaceDir, persona.actualCwd, persona.worktreeBranch, {
          personaId: persona.id,
          personaName: persona.name,
          reason: "persona deleted (claude-code)",
        });
      }
    } else {
      try {
        await ctx.ensureConnected(persona); // opencodeEntry may be null if never reconnected since a restart
        await persona.opencodeEntry.client.session.delete({ path: { id: persona.sessionID } });
      } catch (err) {
        console.error(`[delete] failed to delete OpenCode session ${persona.sessionID}:`, err.message);
      }
      if (persona.isolated) {
        ctx.removeWorktreeAndBranch(persona.workspaceDir, persona.actualCwd, persona.worktreeBranch, {
          personaId: persona.id,
          personaName: persona.name,
          reason: "persona deleted (api)",
        });
      }
    }

    // Archived transcripts outlive a reset but not the persona - leaving them
    // behind would accumulate orphaned directories under data/archives/ that
    // nothing ever references again.
    ctx.removeArchives(persona.id);
    ctx.personas.delete(persona.id);
    ctx.persistAll();
    res.status(204).end();
  });

  return router;
}
