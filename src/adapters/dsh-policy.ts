export const dshPolicyPatch = `
- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: ask
- id: permission
  config:
    defaultPreset: workspace-write
    presets:
      workspace-write:
        sandbox: workspace-write
        approval: ask
- id: tool-web
  config:
    search: false
    fetch: false
`;
