import { useCallback, useMemo, useState } from "react";
import { Check, ChevronDown, Folder, FolderGit2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Card,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui";
import {
  chooseWorkbenchDirectory,
  useWorkbenchDirectories,
  type WorkbenchDirectory,
} from "@/shared/codeyWorkbench";
import { tokenSearchFilter } from "@/modules/chat/utils/commandSearch";

function DirectoryIcon({ directory, className }: { directory: WorkbenchDirectory; className: string }) {
  return directory.worktree ? <FolderGit2 className={className} /> : <Folder className={className} />;
}

/**
 * Where the new session starts, when the Codey Workbench embeds this page and
 * offers more than one directory: a card under the model card, in its design,
 * opening the same kind of searchable list. Picking another directory hands it
 * back to the Workbench, which opens this page again there.
 */
export default function WorkbenchDirectoryPicker() {
  const { t } = useTranslation("chat");
  const offer = useWorkbenchDirectories();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState("");

  /** The offered directories by machine, in the Workbench's order, each with its index in the offer. */
  const machines = useMemo(() => {
    const groups = new Map<string, { directory: WorkbenchDirectory; index: number }[]>();
    offer?.directories.forEach((directory, index) => {
      groups.set(directory.machine, [...(groups.get(directory.machine) ?? []), { directory, index }]);
    });
    return [...groups];
  }, [offer]);

  const setPickerOpen = useCallback((open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setSearch("");
    }
  }, []);

  if (!offer || offer.directories.length < 2) {
    return null;
  }

  const selected = offer.directories[offer.selected];
  const choose = (index: number) => {
    setPickerOpen(false);
    if (index !== offer.selected) {
      chooseWorkbenchDirectory(index);
    }
  };

  return (
    <Dialog open={dialogOpen} onOpenChange={setPickerOpen}>
      <DialogTrigger asChild>
        <Card
          className="group mx-auto mt-2 max-w-xs cursor-pointer border-border/60 transition-all duration-150 hover:border-border hover:shadow-md active:scale-[0.99]"
          role="button"
          tabIndex={0}
          title={`${selected.machine} · ${selected.path}`}
        >
          <div className="flex items-center gap-2 p-3">
            <DirectoryIcon directory={selected} className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="shrink-0 text-xs font-semibold text-foreground">
                  {selected.machine}
                </span>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="truncate text-xs text-foreground">
                  {selected.worktree || selected.name}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {selected.path}
              </p>
            </div>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5" />
          </div>
        </Card>
      </DialogTrigger>

      <DialogContent className="max-w-md overflow-hidden p-0">
        <DialogTitle>Directory Selector</DialogTitle>
        <div className="border-b border-border/60 bg-muted/20 px-4 py-3">
          <p className="text-sm font-semibold text-foreground">
            {t("workbenchDirectory.choose", { defaultValue: "Choose a directory" })}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("workbenchDirectory.description", {
              defaultValue: "The machine and folder the new session starts in",
            })}
          </p>
        </div>
        <Command filter={tokenSearchFilter}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t("workbenchDirectory.search", {
              defaultValue: "Search machines and folders...",
            })}
          />
          <CommandList className="max-h-[350px]">
            <CommandEmpty>
              {t("workbenchDirectory.noneFound", { defaultValue: "No folders found." })}
            </CommandEmpty>
            {machines.map(([machine, entries], groupIndex) => (
              <CommandGroup
                key={machine}
                heading={machine}
                className={groupIndex > 0 ? "border-t border-border/40" : undefined}
              >
                {entries.map(({ directory, index }) => (
                  <CommandItem
                    key={index}
                    value={`${directory.machine} ${directory.name} ${directory.worktree} ${directory.path}`}
                    disabled={!directory.available}
                    onSelect={() => choose(index)}
                  >
                    <DirectoryIcon directory={directory} className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{directory.worktree || directory.name}</div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground">
                        {directory.path}
                      </div>
                    </div>
                    {!directory.available && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {t("workbenchDirectory.unavailable", { defaultValue: "Unavailable" })}
                      </span>
                    )}
                    {index === offer.selected && <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
