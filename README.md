# Ravayat Studio

Ravayat Studio is an experimental, local-first Windows desktop workspace for writing web novels and planning manga or manhwa adaptations. It combines a story editor, a canon and visual-reference library, panel planning, image workflows and export tools.

**Status:** early prototype, shared as-is for future work. The original interface is Persian; the project library and main navigation have an optional, partial English translation. Editing screens, AI settings, messages and generated sample data remain largely Persian. The Persian project guide is available in [README.fa.md](README.fa.md).

## Features

- Organize projects, chapters, scenes, characters, places, objects and story facts locally.
- Attach and approve visual references; plan panels with links to source scenes.
- Draft and export stories and comic layouts. Image consistency is not guaranteed.
- Connect supported AI providers with your own API keys; image generation may incur charges.
- An experimental ChatGPT subscription connection is implemented for eligible analysis; actual sign-in and usage have not been tested with a real user account. Image generation via this connection is not implemented. Choose an image API or transfer prompts and references manually. See [connection notes](docs/chatgpt-plan.md) (Persian).

Stories and assets are stored locally. Requests to external AI providers send selected content to those providers. Review what is sent before generating or analyzing. API keys are stored using the system credential store where available; the app reports fallback behavior when it is unavailable.

## Requirements

- Windows 10/11 x64 for the packaged desktop app.
- Node.js 24 and npm 11 for development. The project uses `node:sqlite`.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3310. For a Windows installer, run `npm run desktop:build`. The installer is unsigned. Other useful commands: `npm run typecheck`, `npm test`, `npm run build`. Automated tests use isolated data and do not validate real provider credentials or costs.

The desktop application uses its user data directory; in development the default is `data/` in the working directory. `RAVAYAT_DATA_DIR` overrides that location. Keep data directories, backups, reference images, keys and `.env` files out of a public repository.

## Known limitations

- English localization is incomplete. Text direction and reading order can be adjusted separately in settings; the built-in sample is Persian.
- AI features and costs depend on provider access, current models and settings. No real API or subscription login was verified as part of this release preparation.
- Generated images are candidates for manual review. Image identity consistency is not guaranteed. PDF output is rasterized.
- This repository does not currently grant an open-source license. Contact the owner before reuse or redistribution.

## Privacy and publishing

The public source snapshot excludes local project databases, credentials, generated images, build outputs and installation files. Before uploading additional material, inspect its contents, metadata and permissions. Third-party files, including the bundled font, need their provenance and redistribution terms checked by the repository owner.

## Vision and why development is paused

The goal is a complete creative workspace that turns a web novel into manga or manhwa while keeping characters, costumes, props, locations and story continuity consistent across many panels. We also wanted AI assistance for story analysis, visual direction, composition and iterative review against approved reference images.

The prototype provides parts of that workflow, but the intended degree of reliable long-form visual consistency and creative control still needs substantial manual correction with the tools available to us. This is our assessment of the project's needs, not a benchmark or a claim that the technology cannot be used for comics. Development is paused for now; we may revisit the project as models and workflows improve.

Possible future work includes stronger identity and scene consistency, pose/depth and local model workflows, improved visual review and director assistance, more complete English localization and real-world provider testing.

