# Project Profile Dashboard and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Replace the raw TOML editor with Profile Studio and provide matching typed CLI profile workflows.

**Architecture:** Dashboard and CLI are thin typed API consumers. Dashboard retains shadcn primitives; CLI uses explicit Clap fields and an optional wizard. Neither creates TOML nor displays secrets.

**Tech Stack:** React 19, TypeScript, Vite, shadcn/ui, Bun, Rust 2024, Clap 4, Reqwest.

## Global Constraints

- Complete foundation and server plans first.
- Keep shadcn; do not introduce a competing component library.
- Main flow: project → profile → effective summary → Run; advanced fields live in a drawer.
- No TOML textarea, generic \`--set key=value\`, or secret value in UI/CLI output.
- Run overrides never mutate profiles; preserve Content Set → Run hand-off.

---

## File Structure

- Modify \`dashboard/src/api.ts\`: typed client; remove raw config calls.
- Create \`dashboard/src/components/ProjectSwitcher.tsx\` and \`ProfileStudio.tsx\`.
- Modify \`dashboard/src/components/RunForm.tsx\` and \`dashboard/src/App.tsx\`.
- Delete \`dashboard/src/components/ConfigEditor.tsx\` only after imports disappear.
- Modify \`crates/thoth-core/src/cli.rs\` and \`lib.rs\`: explicit project/profile commands and wizard.

### Task 1: Introduce typed dashboard API client

**Files:** Modify \`dashboard/src/api.ts\`; create \`dashboard/src/api.test.ts\`.

- [ ] **Step 1: Write the failing wrapper test**

~~~
test("profile job sends typed overrides", async () => {
  mockFetchJson({ job_id: "job-1", profile_revision: 2 });
  await createProfileJob("project-1", { profile_id: "profile-1", overrides: { output_format: "webm" } });
  expect(JSON.parse(lastFetch().body)).toEqual({ profile_id: "profile-1", overrides: { output_format: "webm" } });
});
~~~

- [ ] **Step 2: Run RED**

Run: \`bun test dashboard/src/api.test.ts\`

Expected: FAIL because typed API exports do not exist.

- [ ] **Step 3: Implement client**

Add DTOs matching server JSON and functions for projects, profiles, revisions, validation, profile jobs, and effective settings. Convert non-OK responses to \`{ status, message, field? }\`. Remove \`getConfig\`, \`putConfig\`, and \`getStyleProfiles\`.

- [ ] **Step 4: Run GREEN and commit**

Run: \`bun test dashboard/src/api.test.ts\`

Expected: PASS.

~~~
git add dashboard/src/api.ts dashboard/src/api.test.ts
git commit -m "feat(dashboard): add typed profile API client"
~~~

### Task 2: Build the Profile Studio

**Files:** Create \`ProfileStudio.tsx\` and \`ProfileStudio.test.tsx\`.

- [ ] **Step 1: Write the failing interaction test**

~~~
test("saving a profile sends categorized typed settings", async () => {
  render(<ProfileStudio projectId="p1" onProfileChanged={() => {}} />);
  await user.click(screen.getByRole("button", { name: "New profile" }));
  await user.type(screen.getByLabelText("Profile name"), "Vertical Indonesian");
  await user.selectOptions(screen.getByLabelText("Layout"), "vertical");
  await user.click(screen.getByRole("button", { name: "Save profile" }));
  expect(createProfile).toHaveBeenCalledWith("p1", expect.objectContaining({ name: "Vertical Indonesian" }));
});
~~~

- [ ] **Step 2: Run RED**

Run: \`bun test dashboard/src/components/ProfileStudio.test.tsx\`

Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement Studio**

Use existing \`Button\`, \`Input\`, \`Label\`, \`Select\`, and \`ScrollArea\`: profile list left, six fieldsets center, and effective summary/validation/revisions right. Include create, duplicate, save, restore, and credential-reference status only.

- [ ] **Step 4: Run GREEN and commit**

Run: \`bun test dashboard/src/components/ProfileStudio.test.tsx; bun run build\`

Expected: PASS and build exits 0.

~~~
git add dashboard/src/components/ProfileStudio.tsx dashboard/src/components/ProfileStudio.test.tsx
git commit -m "feat(dashboard): add Profile Studio"
~~~

### Task 3: Make runs profile-first

**Files:** Modify \`RunForm.tsx\`, \`App.tsx\`; create \`RunForm.test.tsx\` and \`ProjectSwitcher.tsx\`.

- [ ] **Step 1: Write the failing behavior test**

~~~
test("run override leaves selected profile untouched", async () => {
  render(<RunForm projectId="p1" onCreated={() => {}} />);
  await user.selectOptions(screen.getByLabelText("Profile"), "profile-1");
  await user.click(screen.getByRole("button", { name: "Overrides for this run" }));
  await user.selectOptions(screen.getByLabelText("Output format"), "webm");
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(createProfileJob).toHaveBeenCalledWith("p1", expect.objectContaining({ overrides: { output_format: "webm" } }));
  expect(updateProfile).not.toHaveBeenCalled();
});
~~~

- [ ] **Step 2: Run RED**

Run: \`bun test dashboard/src/components/RunForm.test.tsx\`

Expected: FAIL because profile controls do not exist.

- [ ] **Step 3: Implement composer and navigation**

Add project switcher and Runs/Profiles/Library/System navigation. Replace raw option grid with profile selector, effective summary, and override drawer. Keep URL/content-set input and consume pending Content Set once. Delete ConfigEditor only after its import is gone.

- [ ] **Step 4: Run GREEN and commit**

Run: \`bun test; bun run lint; bun run build\`

Expected: all commands exit 0.

~~~
git add dashboard/src/App.tsx dashboard/src/components/RunForm.tsx dashboard/src/components/RunForm.test.tsx dashboard/src/components/ProjectSwitcher.tsx dashboard/src/components/ConfigEditor.tsx
git commit -m "feat(dashboard): run jobs from project profiles"
~~~

### Task 4: Add typed CLI commands and configure wizard

**Files:** Modify \`crates/thoth-core/src/cli.rs\`, \`lib.rs\`; add tests to \`cli.rs\`.

- [ ] **Step 1: Write the failing Clap test**

~~~
#[test]
fn profile_set_has_explicit_fields_not_generic_key_value() {
    assert!(Cli::try_parse_from(["thoth", "profile", "set", "Default", "--project", "Demo", "--output-format", "webm"]).is_ok());
    assert!(Cli::try_parse_from(["thoth", "profile", "set", "Default", "--set", "x=y"]).is_err());
}
~~~

- [ ] **Step 2: Run RED**

Run: \`cargo test -p thoth-core profile_set_has_explicit_fields_not_generic_key_value -- --nocapture\`

Expected: FAIL because profile commands do not exist.

- [ ] **Step 3: Implement commands and wizard**

Add \`project { create,list,use }\`, \`profile { create,list,show,duplicate,set }\`, and \`configure\` variants to \`Commands\`. Every mutable field is explicit Clap input. Reuse \`reqwest\` to send dashboard DTOs to the local server. Wizard asks for project, profile name, and non-default fields, then prints a redacted summary.

- [ ] **Step 4: Run GREEN and commit**

Run: \`cargo test -p thoth-core profile -- --nocapture; cargo test -p thoth-core configure -- --nocapture\`

Expected: PASS.

~~~
git add crates/thoth-core/src/cli.rs crates/thoth-core/src/lib.rs crates/thoth-core/Cargo.toml Cargo.lock
git commit -m "feat(cli): manage typed project profiles"
~~~

### Task 5: Document migration and verify the full journey

**Files:** Modify \`README.md\`, \`BLUEPRINT.md\`; create \`docs/superpowers/plans/2026-07-18-project-profile-manual-test.md\`.

- [ ] **Step 1: Write acceptance checklist**

Cover copied-TOML migration, project/profile creation, Profile Studio run, Content Set hand-off, output override, profile edit, old-job snapshot inspection, and secret-redaction inspection.

- [ ] **Step 2: Run final gates**

Run: \`cargo test --workspace; bun --cwd dashboard test; bun --cwd dashboard run lint; bun --cwd dashboard run build\`

Expected: all exit 0. Do not expand deferred repo-wide format or Clippy cleanup.

- [ ] **Step 3: Commit documentation**

~~~
git add README.md BLUEPRINT.md docs/superpowers/plans/2026-07-18-project-profile-manual-test.md
git commit -m "docs: explain project profile workflow"
~~~
