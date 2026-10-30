import { GitBranchPlus, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Card, Input } from "@/shared/ui";
import { cn } from "@/shared/utils";
import type { NewSessionWorktree } from "@/modules/chat/hooks/useNewSessionWorktree";

/**
 * A card under the model card, in its design, when the session's directory is
 * in a git repository: start the session in a new worktree on a new branch,
 * made when the first message goes out, instead of in the directory itself.
 */
export default function NewSessionWorktreeOption({ worktree }: { worktree: NewSessionWorktree }) {
  const { t } = useTranslation("chat");
  if (!worktree.available) {
    return null;
  }

  const { enabled, creating, baseBranch } = worktree;
  const description = creating
    ? t("newSessionWorktree.creating", { defaultValue: "Creating the worktree…" })
    : !enabled
      ? t("newSessionWorktree.off", { defaultValue: "Starts in this folder" })
      : baseBranch
        ? t("newSessionWorktree.on", { branch: baseBranch, defaultValue: "A new branch off {{branch}}, in a folder of its own" })
        : t("newSessionWorktree.onNoBranch", { defaultValue: "A new branch in a folder of its own" });

  return (
    <Card className="mx-auto mt-2 max-w-xs border-border/60">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={creating}
        onClick={() => worktree.setEnabled(!enabled)}
        className="flex w-full items-center gap-2 p-3 text-left disabled:cursor-wait"
      >
        <GitBranchPlus className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-foreground">
            {t("newSessionWorktree.title", { defaultValue: "New worktree" })}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
        </div>
        {creating ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 transition-colors duration-200",
              enabled ? "border-primary bg-primary" : "border-border bg-muted",
            )}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full shadow-sm transition-transform duration-200",
                enabled ? "translate-x-[16px] bg-white" : "translate-x-[1px] bg-foreground/60 dark:bg-foreground/80",
              )}
            />
          </span>
        )}
      </button>
      {enabled && (
        <div className="px-3 pb-3">
          <Input
            type="text"
            value={worktree.branch}
            onChange={(event) => worktree.setBranch(event.target.value)}
            disabled={creating}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={t("newSessionWorktree.branch", { defaultValue: "Branch name" })}
            placeholder={t("newSessionWorktree.branchPlaceholder", { defaultValue: "Branch name (blank: one is made up)" })}
            className="h-8 px-2 font-mono text-xs placeholder:font-sans"
          />
        </div>
      )}
    </Card>
  );
}
