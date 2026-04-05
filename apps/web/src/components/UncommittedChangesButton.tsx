import { useQuery } from "@tanstack/react-query";
import { FilesIcon } from "lucide-react";
import { memo } from "react";

import { Badge } from "~/components/ui/badge";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";

interface UncommittedChangesButtonProps {
  gitCwd: string | null;
  changesOpen: boolean;
  onToggleChanges: () => void;
}

export const UncommittedChangesButton = memo(function UncommittedChangesButton({
  gitCwd,
  changesOpen,
  onToggleChanges,
}: UncommittedChangesButtonProps) {
  const { data: gitStatus = null } = useQuery(gitStatusQueryOptions(gitCwd));
  const fileCount = gitStatus?.workingTree.files.length ?? 0;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="relative shrink-0"
            pressed={changesOpen}
            onPressedChange={onToggleChanges}
            aria-label="Toggle uncommitted changes panel"
            variant="outline"
            size="xs"
          >
            <FilesIcon className="size-3" />
            {fileCount > 0 && (
              <Badge
                variant="default"
                size="sm"
                className="absolute -end-1.5 -top-1.5 pointer-events-none min-w-4 px-0.5"
              >
                {fileCount > 99 ? "99+" : fileCount}
              </Badge>
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {fileCount > 0 ? `${fileCount} uncommitted change(s)` : "No uncommitted changes"}
      </TooltipPopup>
    </Tooltip>
  );
});
