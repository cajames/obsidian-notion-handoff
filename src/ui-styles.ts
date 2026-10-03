// Bundled into main.js so installs still need only main.js and manifest.json.
export const uiStyles = `
.notion-handoff-settings {
  color: var(--text-normal);
  font-family: var(--font-interface);
  max-width: 850px;
  margin: 0 auto;
  container-type: inline-size;
  container-name: nh-settings;
}
.notion-handoff-settings .nh-section + .nh-section { margin-top: 32px; }
.notion-handoff-settings .nh-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.notion-handoff-settings h2 {
  margin: 0;
  font-size: var(--font-ui-large, 20px);
  font-weight: 600;
  letter-spacing: -0.02em;
}
.notion-handoff-settings .nh-section-description {
  margin: 8px 0 18px;
  color: var(--text-muted);
  font-size: var(--font-ui-small, 14px);
  line-height: 1.5;
}
.notion-handoff-settings .nh-profiles { display: grid; gap: 12px; }
.notion-handoff-settings .nh-profile,
.notion-handoff-settings .nh-image-settings {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 12px;
  overflow: hidden;
}
.notion-handoff-settings .nh-profile-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px;
  background: var(--background-secondary);
  cursor: pointer;
  list-style: none;
}
.notion-handoff-settings .nh-profile-heading::-webkit-details-marker { display: none; }
.notion-handoff-settings .nh-profile-heading::before {
  content: '›';
  color: var(--text-muted);
  font-size: 20px;
  line-height: 1;
}
.notion-handoff-settings .nh-profile[open] > .nh-profile-heading::before { transform: rotate(90deg); }
.notion-handoff-settings .nh-profile-name {
  font-size: var(--font-ui-medium, 15px);
  font-weight: 600;
  overflow-wrap: anywhere;
}
.notion-handoff-settings .nh-profile-order { display: flex; flex-shrink: 0; gap: 6px; margin-left: auto; }
.notion-handoff-settings .nh-profile-order button { width: 30px; height: 30px; padding: 0; }
.notion-handoff-settings .nh-profile-order svg { width: 14px; height: 14px; }
.notion-handoff-settings .nh-profile-fields { padding: 0 18px; }
.notion-handoff-settings .nh-profile-hint {
  margin: 14px 0 0;
  color: var(--text-muted);
  font-size: var(--font-ui-smaller, 12px);
  overflow-wrap: anywhere;
}
.notion-handoff-settings .nh-profile-hint code {
  padding: 0;
  background: transparent;
  color: inherit;
  font-size: inherit;
}
.notion-handoff-settings .setting-item {
  display: flex;
  align-items: center;
  gap: 24px;
  margin: 0;
  padding: 15px 0;
  border: 0;
  border-top: 1px solid var(--background-modifier-border);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.notion-handoff-settings .nh-profile-hint + .setting-item,
.notion-handoff-settings .nh-image-settings > .setting-item:first-child { border-top: 0; }
.notion-handoff-settings .setting-item-info { flex: 1; min-width: 0; margin: 0; }
.notion-handoff-settings .setting-item-name {
  color: var(--text-normal);
  font-size: var(--font-ui-small, 14px);
  font-weight: 500;
}
.notion-handoff-settings .setting-item-description {
  color: var(--text-muted);
  margin-top: 4px;
  font-size: var(--font-ui-smaller, 12px);
  line-height: 1.5;
}
.notion-handoff-settings .setting-item-control {
  flex: 0 1 45%;
  min-width: 0;
  max-width: 340px;
  padding: 0;
}
.notion-handoff-settings .setting-item-control input,
.notion-handoff-settings .setting-item-control select {
  width: 100%;
  min-width: 0;
  min-height: 36px;
  font-size: var(--font-ui-small, 14px);
}
.notion-handoff-settings .nh-profile-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-top: 1px solid var(--background-modifier-border);
  padding: 10px 18px;
}
.notion-handoff-settings .nh-profile-footer span,
.notion-handoff-settings .nh-footnote {
  color: var(--text-muted);
  font-size: var(--font-ui-smaller, 12px);
  line-height: 1.5;
}
.notion-handoff-settings .nh-profile-footer button {
  flex-shrink: 0;
  font-size: var(--font-ui-smaller, 12px);
}
.notion-handoff-settings .nh-footnote { margin: 12px 0 0; }
.notion-handoff-settings .nh-image-settings { padding: 0 18px; }
.notion-handoff-settings .nh-field-error {
  margin: 0 0 14px;
  color: var(--text-error);
  font-size: var(--font-ui-smaller, 12px);
  line-height: 1.5;
}
.notion-handoff-settings [hidden] { display: none; }
.notion-handoff-settings button:focus-visible,
.notion-handoff-settings summary:focus-visible,
.notion-handoff-settings input:focus-visible,
.notion-handoff-settings select:focus-visible,
.notion-handoff-push button:focus-visible,
.notion-handoff-push summary:focus-visible {
  outline: 2px solid var(--interactive-accent);
  outline-offset: 3px;
}
.modal.notion-handoff-push-modal { width: min(620px, calc(100vw - 32px)); }
.modal.notion-handoff-workspace-picker { width: min(460px, calc(100vw - 32px)); }
.notion-handoff-push .nh-picker-description { color: var(--text-muted); font-size: var(--font-ui-small, 14px); line-height: 1.6; }
.notion-handoff-push .nh-workspace-choice.setting-item { padding: 0; border: 0; background: transparent; }
.notion-handoff-push .nh-workspace-choice .setting-item-info { display: none; }
.notion-handoff-push .nh-workspace-choice .setting-item-control { padding: 0; margin: 0; }
.notion-handoff-push .nh-workspace-choice .setting-item-control,
.notion-handoff-push .nh-workspace-choice select { width: 100%; }
.notion-handoff-push { font-family: var(--font-interface); }
.notion-handoff-push .nh-push-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 4px 0 16px;
  padding-right: 20px;
  color: var(--text-muted);
  font-size: var(--font-ui-smaller, 12px);
}
.notion-handoff-push .nh-direction {
  display: flex;
  align-items: center;
  gap: 8px;
}
.notion-handoff-push .nh-direction svg { width: 14px; height: 14px; }
.notion-handoff-push h2 {
  margin: 0 0 18px;
  color: var(--text-normal);
  font-size: var(--font-ui-large, 20px);
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.02em;
}
.notion-handoff-push .nh-push-warning {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  margin-bottom: 18px;
  border: 1px solid var(--background-modifier-border);
  border-left: 3px solid var(--text-warning, var(--color-orange));
  border-radius: 9px;
  background: var(--background-secondary);
}
.notion-handoff-push .nh-warning-icon {
  flex: 0 0 18px;
  margin-top: 2px;
  color: var(--text-warning, var(--color-orange));
}
.notion-handoff-push .nh-warning-icon svg { width: 18px; height: 18px; }
.notion-handoff-push .nh-push-warning strong { font-size: var(--font-ui-small, 14px); font-weight: 600; }
.notion-handoff-push .nh-push-warning p {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: var(--font-ui-small, 14px);
  line-height: 1.6;
}
.notion-handoff-push .nh-push-diff {
  border: 1px solid var(--background-modifier-border);
  border-radius: 9px;
  overflow: hidden;
}
.notion-handoff-push .nh-diff-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 12px 14px;
  cursor: pointer;
  list-style: none;
  font-size: var(--font-ui-small, 14px);
}
.notion-handoff-push .nh-diff-summary::-webkit-details-marker { display: none; }
.notion-handoff-push .nh-diff-summary::before { content: '›'; color: var(--text-muted); }
.notion-handoff-push .nh-push-diff[open] > .nh-diff-summary::before { transform: rotate(90deg); }
.notion-handoff-push .nh-diff-count {
  margin-left: auto;
  color: var(--text-muted);
  font-size: var(--font-ui-smaller, 12px);
}
.notion-handoff-push .nh-diff-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 10px 14px;
  border-top: 1px solid var(--background-modifier-border);
  font-size: var(--font-ui-smaller, 12px);
}
.notion-handoff-push .nh-diff-added { color: var(--text-success); }
.notion-handoff-push .nh-diff-removed { color: var(--text-error); }
.notion-handoff-push .nh-diff-note { width: 100%; color: var(--text-muted); }
.notion-handoff-push .nh-diff-content {
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
  padding: 14px;
  border-top: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  font-family: var(--font-monospace);
  font-size: var(--font-ui-smaller, 12px);
  line-height: 1.7;
}
.notion-handoff-push .nh-push-actions.setting-item {
  display: flex;
  justify-content: flex-end;
  margin: 20px 0 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.notion-handoff-push .nh-push-actions .setting-item-info { display: none; }
.notion-handoff-push .nh-push-actions .setting-item-control {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
  padding: 0;
}
.notion-handoff-push .nh-push-actions button { min-height: 36px; font-size: var(--font-ui-small, 14px); }
.notion-handoff-push .nh-push-actions .mod-warning {
  color: var(--text-on-accent, white);
  background: var(--color-red);
  background: color-mix(in srgb, var(--color-red) 78%, black);
  border: 1px solid transparent;
}
.notion-handoff-push .nh-push-actions .mod-warning:hover { filter: brightness(1.08); }
@container nh-settings (max-width: 540px) {
  .notion-handoff-settings .setting-item { flex-direction: column; align-items: stretch; gap: 10px; }
  .notion-handoff-settings .setting-item-control { flex: auto; width: 100%; max-width: none; }
  .notion-handoff-settings .nh-profile-footer { flex-wrap: wrap; }
}
@media (max-width: 600px) {
  .notion-handoff-settings button { min-height: 42px; }
  .notion-handoff-settings .setting-item { flex-direction: column; align-items: stretch; gap: 10px; }
  .notion-handoff-settings .setting-item-control { flex: auto; width: 100%; max-width: none; }
  .notion-handoff-settings .nh-profile-footer { flex-wrap: wrap; }
  .notion-handoff-push .nh-push-actions .setting-item-control { width: 100%; }
  .notion-handoff-push .nh-push-actions button { flex: 1; min-height: 42px; }
  .notion-handoff-push .nh-diff-count { width: 100%; margin-left: 14px; }
}
`;
