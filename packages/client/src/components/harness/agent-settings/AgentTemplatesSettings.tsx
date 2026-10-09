import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { SectionHeader } from "@/components/harness/form-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createClientId } from "@/lib/id";
import type { PromptTemplate } from "@carmel-agent/shared";

export function AgentTemplatesSettings({
  templates,
  onChange,
}: {
  templates: PromptTemplate[];
  onChange: (templates: PromptTemplate[]) => void;
}) {
  const [templateName, setTemplateName] = useState("");
  const [templateBody, setTemplateBody] = useState("");

  const addPromptTemplate = () => {
    const name = templateName.trim();
    const body = templateBody.trim();
    if (!name || !body) return;
    onChange([...templates, { id: createClientId("template"), name, body }]);
    setTemplateName("");
    setTemplateBody("");
  };

  return (
    <section className="grid gap-4">
      <SectionHeader
        title="Prompt Templates"
        description="Templates appear in the chat command palette for this agent."
      />
      <div className="grid gap-3">
        {templates.length > 0 ? (
          <div className="grid gap-2">
            {templates.map((template) => (
              <div key={template.id} className="flex items-start gap-2 rounded-md border p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{template.name}</div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {template.body}
                  </div>
                </div>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  title="Delete template"
                  onClick={() => onChange(templates.filter((item) => item.id !== template.id))}
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="grid gap-3 rounded-md border p-3">
          <Field>
            <FieldLabel>Template name</FieldLabel>
            <Input value={templateName} onChange={(event) => setTemplateName(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Template text</FieldLabel>
            <Textarea
              value={templateBody}
              onChange={(event) => setTemplateBody(event.target.value)}
            />
          </Field>
          <div>
            <Button type="button" variant="secondary" onClick={addPromptTemplate}>
              <PlusIcon data-icon="inline-start" />
              Add template
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
