/**
 * What to do when a speech-recognition session ends (symposion-I91).
 *
 * The Web Speech API ends a session on its own — a silence gap is the common
 * case — even with `continuous = true`. Dictation therefore has to decide,
 * every time a session ends, whether to start another one. Get that wrong in
 * the permissive direction and you get a hot restart loop against a blocked
 * microphone; get it wrong in the strict direction and dictation dies on the
 * first natural pause, which is what it did before this file existed.
 *
 * Kept as a separate classic script, and free of DOM and timers, so the
 * decision is unit-testable. `public/app.js` is a classic script (not a
 * module), so this attaches to `window` rather than exporting; the test loads
 * it with node:vm. Making app.js itself testable is a bigger change and is
 * tracked separately as symposion-I39 / policy T1-1 — not smuggled in here.
 */
(function (root) {
  "use strict";

  // Terminal: retrying cannot help, and the user has to do something.
  const TERMINAL_ERRORS = {
    "not-allowed":
      "Microphone access is blocked. Allow it for this site in your browser settings, then try again.",
    "service-not-allowed":
      "Speech recognition was refused by the browser. Check this site's microphone permission.",
    "audio-capture":
      "No microphone was found. Check that one is connected and selected as the input device.",
  };

  // Expected during normal dictation — never surfaced to the user.
  // `no-speech` fires on a silence gap, which is the case this whole file
  // exists to keep working. `aborted` means stop()/abort() was called.
  const BENIGN_ERRORS = new Set(["no-speech", "aborted"]);

  const DEFAULT_MAX_EMPTY_RESTARTS = 3;

  /**
   * @param {object}  state
   * @param {boolean} state.wanted              is the user still dictating?
   * @param {string|null} state.error           SpeechRecognitionErrorEvent.error, if any
   * @param {number}  state.emptyRestarts       consecutive restarts that produced no final text
   * @param {number}  [state.maxEmptyRestarts]
   * @returns {{action: "restart"|"stop", reason: string, message: string|null}}
   *          `message` non-null means show it to the user.
   */
  function decideDictationNext(state) {
    const {
      wanted,
      error = null,
      emptyRestarts = 0,
      maxEmptyRestarts = DEFAULT_MAX_EMPTY_RESTARTS,
    } = state || {};

    // Checked first, and regardless of `wanted`: a blocked microphone is worth
    // reporting even if the user had already pressed stop, because otherwise
    // the next attempt fails the same silent way.
    if (error && Object.prototype.hasOwnProperty.call(TERMINAL_ERRORS, error)) {
      return { action: "stop", reason: "terminal-error", message: TERMINAL_ERRORS[error] };
    }

    if (!wanted) return { action: "stop", reason: "user-stopped", message: null };

    if (error === "aborted") return { action: "stop", reason: "aborted", message: null };

    // An unrecognised code is NOT assumed benign. Restarting into an unknown
    // failure is how a hot loop starts; naming the code is how it gets fixed.
    if (error && !BENIGN_ERRORS.has(error)) {
      return { action: "stop", reason: "unknown-error", message: `Dictation stopped (${error}).` };
    }

    // Restarting forever against silence burns battery and looks identical to
    // working. Cap it and say so.
    if (emptyRestarts >= maxEmptyRestarts) {
      return {
        action: "stop",
        reason: "no-speech",
        message: "Stopped listening — no speech detected. Check your microphone and try again.",
      };
    }

    return {
      action: "restart",
      reason: error === "no-speech" ? "silence" : "session-ended",
      message: null,
    };
  }

  root.DictationPolicy = {
    decideDictationNext,
    TERMINAL_ERRORS,
    BENIGN_ERRORS,
    DEFAULT_MAX_EMPTY_RESTARTS,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
