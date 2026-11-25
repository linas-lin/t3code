import { useGT } from "gt-react";
import { useState, type FormEvent } from "react";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { MAX_THREAD_GROUP_NAME_LENGTH, normalizeThreadGroupName } from "./threadGrouping.logic";

export interface ThreadGroupNameDialogProps {
  readonly open: boolean;
  readonly mode: "create" | "rename";
  readonly initialValue?: string;
  readonly existingGroups?: readonly string[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (groupName: string) => void;
}

function ThreadGroupNameDialogForm(props: Omit<ThreadGroupNameDialogProps, "open">) {
  const gt = useGT();
  const [value, setValue] = useState(props.initialValue ?? "");

  const normalized = normalizeThreadGroupName(value);
  const trimmedInitial = normalizeThreadGroupName(props.initialValue ?? "");
  const isUnchangedRename = props.mode === "rename" && normalized === trimmedInitial;
  const willMergeExisting =
    props.mode === "rename" &&
    normalized !== null &&
    normalized !== trimmedInitial &&
    (props.existingGroups?.includes(normalized) ?? false);
  const canSubmit = normalized !== null && !isUnchangedRename;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || normalized === null) return;
    props.onSubmit(normalized);
    props.onOpenChange(false);
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>
          {props.mode === "create" ? gt("New thread group") : gt("Rename thread group")}
        </DialogTitle>
        <DialogDescription>
          {props.mode === "create"
            ? gt("Group related threads within this project, such as a ticket key or topic.")
            : gt("Update the group name for all threads in this group within the project.")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <Input
          autoFocus
          maxLength={MAX_THREAD_GROUP_NAME_LENGTH}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={gt("e.g. BLUE-123")}
          aria-label={gt("Group name")}
        />
        {willMergeExisting ? (
          <p className="text-xs text-muted-foreground">
            {gt('A group named "{name}" already exists. Saving will merge them.', {
              name: normalized,
            })}
          </p>
        ) : null}
        {props.mode === "create" && props.existingGroups && props.existingGroups.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {props.existingGroups.slice(0, 8).map((group) => (
              <button
                key={group}
                type="button"
                onClick={() => setValue(group)}
                className="cursor-pointer rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {group}
              </button>
            ))}
          </div>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
          {gt("Cancel")}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {props.mode === "create" ? gt("Save") : gt("Rename")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ThreadGroupNameDialog(props: ThreadGroupNameDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-sm">
        {props.open ? (
          <ThreadGroupNameDialogForm
            key={`${props.mode}:${props.initialValue ?? ""}`}
            mode={props.mode}
            {...(props.initialValue !== undefined ? { initialValue: props.initialValue } : {})}
            {...(props.existingGroups !== undefined
              ? { existingGroups: props.existingGroups }
              : {})}
            onOpenChange={props.onOpenChange}
            onSubmit={props.onSubmit}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
