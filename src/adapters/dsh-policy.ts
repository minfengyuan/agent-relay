export const dshPolicyPatch = `
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
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
`;
