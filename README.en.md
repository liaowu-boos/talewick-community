# Talewick

**Turn a story idea into a draft you can keep shaping.**

[中文](README.md) | English

Talewick is a locally hosted AI fiction workspace, primarily designed for Chinese short fiction. Discuss an idea with the assistant, generate a chapter-based draft, read and edit it, then request changes to the whole manuscript or a selected passage. You decide which suggestions become part of your story.

The project separates the writing interface, source material management, writing workflow, and validation tools. Clear module boundaries make the workflow easier to extend and inspect.

> This is a preview project under active development. Start from source using the instructions below. Historical local release bundles, experiment reports, and static demos do not certify the current source version. The interface and most documentation are in Chinese; this English README does not imply full English product support.

![Talewick workspace](examples/workspace.png)

## Latest update · 2026-10-16

- **Independent manuscript reading**: request two isolated readings from the manuscript view, inspect complete opinions and history, and follow exact quotations into the frozen draft. Reports indicate whether they match the current version.
- **Blind revision comparison**: four single-draft readings, two comparisons in reversed order, and one goal audit. Disagreements, stage evidence, and failures remain visible; adoption is the author's decision.
- **Whole-manuscript quality revision**: prioritize major issues, inspect evidence and counterevidence, assess material applicability and editing scope, then revise and reread. Grouped adoption and original preservation protect manual edits from stale candidates.
- **Materials and recovery**: narrative observation windows participate in retrieval, with separate direct-fit, mechanism-only, inapplicable, and insufficient-context decisions. Final-text material references are checked. Cloud-only iCloud files produce a waiting state instead of blocking startup.

The workflow and evidence chain are connected, but live development runs still showed inconsistent diagnoses and unchanged candidates. **Literary quality improvement has not been demonstrated.** Full15 remains limited to C01–C06 assistance; completion, zero findings, or model preferences do not certify literary quality. Private source libraries, analysis samples, and captured provider responses are excluded. The six existing [reading examples](examples/README.md) remain available. See the [verification record](VERIFICATION.md) for the checks actually run.

## What you can do

- **Discuss and draft**: describe your genre, characters, conflict, length, and ending, then proceed through requirements, planning, and chapter-by-chapter writing.
- **Review and revise**: receive an independent manuscript review and request whole-manuscript, targeted, or passage-level revisions. Review candidates and differences before accepting them.
- **Protect your manuscript**: edit, compare versions, and restore earlier text. If you edit while generation is running, the model output is kept separately.
- **Save and resume tasks**: preserve stage outputs, task state, and completed chapters; cancel tasks, resume interrupted work, and recover progress after a page refresh.
- **Use reference material**: import TXT/Markdown and manage knowledge and style references. The data module supports analysis, retrieval, and relevance screening; available material depends on your local library.
- **Export your work**: download TXT or Markdown from the workspace.

## Quick start

### 1. Prepare your environment

- Node.js **22.13 or later**, with npm.
- Python **3.10 or later**, available as `python3` in the server environment. Run `python3 --version` to confirm; the review tools use only the standard library.
- Download and extract this repository, or clone it with Git.
- Have a model API base URL, model ID, and API key ready. The default Agent workflow requires tool calling support.

To clone with Git, run:

```sh
git clone https://github.com/liaowu-boos/talewick-community.git
cd talewick-community
```

Keep the repository structure intact: the product server imports the sibling data, creation, and validation modules. Run these commands from the repository root:

```sh
cd modules/product/talewick-gui
npm ci
cp .env.example .env.local
```

On Windows PowerShell, use `Copy-Item .env.example .env.local` to copy the configuration file.

### 2. Configure your model

Edit the newly created `.env.local`:

```dotenv
TALEWICK_API_BASE_URL=https://api.deepseek.com
TALEWICK_MODEL=your-model-id
TALEWICK_API_KEY=your-api-key
TALEWICK_PORT=4326
TALEWICK_ENGINE=ai-sdk
```

Replace `your-model-id` with a model available from your provider and `your-api-key` with your own key. Check the model ID in the example file too; it is not a guarantee of availability. You can initially keep the other timeout settings from that file.

The code includes DeepSeek and OpenAI-compatible adapters. For another provider, change the base URL and model ID. Tool calling, structured output, and output length support must be verified for the particular model.

To use the fixed writing workflow, set `TALEWICK_ENGINE=fixed`. This changes the execution engine for new writing tasks only; existing tasks resume with their original engine. It does not remove tool calling requirements from the conversation interface or every other feature. Restart the server after changing configuration.

### 3. Build and start

Still inside `modules/product/talewick-gui`, run:

```sh
npm run build
npm start
```

Open [http://127.0.0.1:4326](http://127.0.0.1:4326). For example, send:

> Write a Chinese short story of about 3,000 Chinese characters. A postal worker about to retire receives a letter addressed to their younger self thirty years ago. Open with suspense, focus on a father–daughter relationship, and keep the ending restrained. Do not explain the events as a dream.

When the draft is ready, edit it directly or select a passage and request a specific change, then review and accept the suggestions.

The public edition contains no private source corpus, analysis dataset, or historical release bundles. See [reading examples](examples/README.md) for six complete stories, including two delivered on 2026-10-09. They are not automatically loaded into the library.

For a complete draft, click **整稿修订** (whole-manuscript revision) in the manuscript toolbar and describe your objective. After starting, review the plan, candidate, differences, and reread risks, then accept the candidate or keep your original. Opening the dialog alone makes no model request.

## Data and model calls

The interface and server run locally. Generation sends the requirements, manuscript, and relevant reference material to your configured model provider and may incur API charges. A single writing task involves multiple model calls. The separate review after saving a new draft normally adds two requests; manual rechecks may also incur charges. You can cancel from the manuscript check panel.

- The server reads your API key from `.env.local`. Do not commit that file.
- Tasks and generated artifacts are stored in `.local-runs/` under the product directory by default. Set `TALEWICK_RUNS_DIR` to change this location.
- The browser also stores project and editing state. Clearing browser data does not delete task files on disk, but there is no complete one-click project reconstruction interface yet.
- Export important manuscripts and back up both browser data and task files. Remove keys, private manuscripts, and personal paths from Issue and PR attachments.

Whole-manuscript diagnosis, planning, scene changes, and rereading also make separate model requests. The total depends on the plan and any recovery steps.

## Current scope

| Area | Status |
| --- | --- |
| Deployment | Local web workspace; the source server binds to `127.0.0.1` by default |
| Writing engine | AI SDK ToolLoopAgent by default; fixed workflow also available |
| Quality checks | Model review, manuscript state and cross-chapter event checks, and separate C01–C06 checks; the historical Full15 platform is not enabled, and real-provider validation of the public rule edition remains limited |
| Auxiliary scope | C05 requires an explicit chapter-four/five cut requirement; the product supplies no reference corpus, so C06 is not evaluated |
| Reference library | Requires local imports or configuration; sample counts in development reports do not mean a fresh installation includes that library |
| Interaction modes | Automatic drafting, targeted revision, and whole-manuscript revision are connected; complete stage-by-stage assisted and professional review interactions are unfinished |
| Other capabilities | Style training, a complete product account system, and native desktop installers are unfinished |
| Export | TXT/Markdown in the workspace; PDF/ZIP export is not included in the current public edition |

A completed task or passing engineering tests do not establish publication readiness or prove that a writing method improves literary quality. Authors still need to judge and edit the final manuscript.

## Repository structure

```text
modules/
  product/talewick-gui/             # React interface and local Node.js server
  creation/runtime/                # Requirements, planning, writing, review, revision
  creation/novel-review/            # Python checks, public rules, and synthetic tests
  creation/write-short-fiction-candidate/references/  # Workflow rules
  data/                            # Sources, analysis, and knowledge delivery
  validation/                      # Basic checks and experimental validation

examples/                          # Six stories, including two recent revised manuscripts
licenses/                          # Third-party licenses
```

Active product development lives in `modules/product/talewick-gui/`; see [module responsibilities](modules/README.md). Processing code is public, but the private dataset is not included. New installations start with an empty library.

## Contributing

Issues and Pull Requests are welcome. Useful areas include installation, model adapters, task recovery, reference retrieval, editing interactions, tests, and documentation translation.

### Local development

Complete model configuration and `npm ci`, then open two terminals in the product directory:

```sh
# Terminal 1: backend
npm start
```

```sh
# Terminal 2: frontend development server
npm run dev -- --port 4323
```

Open [http://127.0.0.1:4323](http://127.0.0.1:4323). Vite proxies `/api` to port `4326` by default. If you change the backend port, update the proxy in `vite.config.ts` as well.

Before submitting, run `node tools/check-public.mjs` from the repository root, then run the relevant checks from the product directory:

```sh
npm run test:runtime
npm run test:ui
npm run test:review
npm run build
```

`test:runtime` includes the public creation/reference-decision, narrative-observation, continuity, and whole-revision suites, and covers the server, creation runtime, reference screening, auxiliary review tasks, and interface state tests selected by the package script. `test:review` runs the Python protocol tests. These do not cover every experiment in the repository. Passing tests do not replace real-provider compatibility checks or literary evaluation.

### Submission guidelines

1. For bugs, include reproduction steps, expected and actual behavior, your operating system and Node.js version, and sanitized model settings and errors.
2. For substantial features or architecture changes, open an Issue to discuss the problem and scope first.
3. Keep each PR focused. Explain the change, validation, and known limitations; include screenshots for interface changes.
4. Read the [product development conventions](modules/product/talewick-gui/AGENTS.md) before changing the interface. Preserve manuscript protection, user acceptance of edits, and task recovery behavior.
5. Do not submit `.env.local`, private run directories, unauthorized text, or generated files unrelated to your change.

## Further reading

- [Product runtime entry](modules/product/talewick-gui/README.md)
- [Module responsibilities](modules/README.md)
- [Manuscript checks](modules/creation/novel-review/README.md)
- [File library](modules/data/runtime/FILE-LIBRARY.md)
- [Reading examples](examples/README.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License and third-party materials

Original code in this project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0-only)](LICENSE). Use, modification, and commercial use are permitted, subject to the license. Distribution of covered works carries source availability and license notice obligations. If you modify the program and let users interact with it over a network, you must offer those users the Corresponding Source of that modified version as required by the license. See [LICENSE](LICENSE) for the full terms.

Third-party code, fonts, images, and text retain their own licenses or permission requirements; they are not relicensed by this project’s use of AGPL-3.0. Contributors retain ownership and provide original contributions under AGPL-3.0-only; any additional commercial licensing will be agreed separately. See the [contribution guide](CONTRIBUTING.en.md).
