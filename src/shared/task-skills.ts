export interface TaskSkillField {
  key: string; label: string; type: "text" | "textarea" | "select";
  required?: boolean; placeholder?: string; default?: string; options?: string[];
}
/** ProfilePilot UI extension. SKILL.md remains the portable business workflow. */
export interface TaskSkillDefinition {
  schemaVersion: 1; id: string; version: string; title: string; description: string;
  goal: string; inputs: TaskSkillField[];
}
export interface TaskSkillSelection { id: string; parameters: Record<string, string>; }
export interface TaskSkillRun extends TaskSkillSelection {
  title: string; version: string; digest: string; root: string; instructions: string;
}
export function skillDefaults(skill: TaskSkillDefinition): Record<string, string> {
  return Object.fromEntries(skill.inputs.map(field => [field.key, field.default || ""]));
}
