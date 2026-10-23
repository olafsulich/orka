// Committed feature specs in the target repo: specs/<feature>/spec.md holds what,
// why, limits and done criteria. orka new --spec builds the job intake from it, and
// every worker and verifier brief gets the spec text pasted in.

export const SPEC_DIR = "specs";
export const SPEC_FILE = "spec.md";
// Prompt cap for the pasted spec; the full file is always in the worktree.
export const SPEC_PROMPT_MAX = 6000;
export const REQUIRED = ["what", "done when"];
const SECTIONS = ["What", "Why", "Limits", "Done when"];

export function assertFeature(feature) {
  const name = String(feature ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) fail(`feature name must match [a-z0-9][a-z0-9-]{0,63}, got "${name}"`);
  return name;
}

function fail(msg) {
  const err = new Error(msg);
  err.orka = true;
  throw err;
}

export const specRelPath = (feature) => `${SPEC_DIR}/${feature}/${SPEC_FILE}`;

export function specTemplate(feature, date = new Date().toISOString().slice(0, 10)) {
  return `# ${feature}

Stage: idea
Kind: feature
Created: ${date}

## What
<!-- What the feature does, in a few lines. -->

## Why
<!-- Why it matters now, and for whom. -->

## Limits
<!-- Out of scope, constraints, files not to touch. -->

## Done when
<!-- One checkable criterion per line; the verifier checks each one. -->
`;
}

const stripComments = (text) => String(text).replace(/<!--[\s\S]*?-->/g, "");

// { title, stage, kind, sections: { "<lowercase heading>": body } }. Bodies have comments removed and are trimmed.
export function parseSpec(text) {
  const out = { title: "", stage: "", kind: "", sections: {} };
  let current = null;
  const lines = stripComments(text).split(/\r?\n/);
  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      current = h2[1].toLowerCase();
      out.sections[current] = "";
      continue;
    }
    if (h1 && !out.title && current === null) {
      out.title = h1[1];
      continue;
    }
    if (current === null) {
      const field = /^(Stage|Kind):\s*(.+?)\s*$/i.exec(line);
      if (field) out[field[1].toLowerCase()] = field[2].toLowerCase();
      continue;
    }
    out.sections[current] += `${line}\n`;
  }
  for (const key of Object.keys(out.sections)) out.sections[key] = out.sections[key].trim();
  return out;
}

export function missingSections(spec) {
  return REQUIRED.filter((key) => !spec.sections[key]);
}

// The job goal (intake) built from the spec. Only the four core sections; the rest stays in the pasted spec.
export function specIntake(spec, relPath, commit) {
  const lines = [`Build the feature specified in ${relPath}${commit ? ` (committed at ${commit.slice(0, 8)})` : ""}. The spec is the source of truth; orka pastes it into every worker and verifier brief.`];
  for (const name of SECTIONS) {
    const body = spec.sections[name.toLowerCase()];
    if (!body) continue;
    lines.push("", `${name}:`, body);
  }
  return lines.join("\n");
}

// The block pasted into worker and verifier briefs.
export function specBlock(text, relPath) {
  const body = String(text).trim();
  const capped = body.length > SPEC_PROMPT_MAX ? `${body.slice(0, SPEC_PROMPT_MAX)}\n[spec cut at ${SPEC_PROMPT_MAX} characters; read the rest in ${relPath}]` : body;
  return [`SPEC (${relPath}, the source of truth for this job; every "Done when" line is an acceptance criterion):`, capped].join("\n");
}
