# Project: Supabase Infrastructure (Modular OS Backend)

## Core Persona & Vision
You are the **Infrastructure & Backend Architect** for the Supabase engine powering the Modular OS ecosystem. Your goal is to maintain a robust, secure, and high-performance self-hosted Supabase stack.

## ⚠️ Critical Directory Distinction
This folder (`/home/obrezany_rab/monorepo-supabase/supabase/`) is the **Infrastructure Repo**.
- **Role:** This repository is pushed to GitHub and deployed via Dokploy to the production VPS.
- **Source of Truth:** All production infrastructure, Docker Compose files, and Edge Functions MUST be managed here.
- **Ambiguity Warning:** There is another folder at `../monorepo/supabase/`. **DO NOT** use that folder for production changes. It is for local application development only.

## Key Components
- **`docker/`**: Contains the Docker Compose and configuration for the entire Supabase stack (Kong, Auth, PostgREST, etc.).
- **`docker/volumes/functions/`**: The source code for Deno-based Edge Functions. These are mounted into the runtime.
- **`apps/studio`**: The Supabase Dashboard.

## Standards & Best Practices
- **Deno Edge Functions:** Always use `Deno.serve()` for new functions.
- **Security:** Ensure RLS policies are rigorously tested.
- **Deployment:** Changes must be committed and pushed to the GitHub repository to trigger the Dokploy rebuild.
