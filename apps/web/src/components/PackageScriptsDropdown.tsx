import type { PackageManagerId, PackageScriptEntry } from "@codewithme/contracts";
import { ChevronDownIcon, FileJson2Icon } from "lucide-react";
import { memo } from "react";

import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

interface PackageScriptsDropdownProps {
  scripts: readonly PackageScriptEntry[];
  packageManager: PackageManagerId;
  onRunScript: (runCommand: string) => void;
}

export const PackageScriptsDropdown = memo(function PackageScriptsDropdown({
  scripts,
  packageManager,
  onRunScript,
}: PackageScriptsDropdownProps) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="outline" aria-label="Package scripts">
            <FileJson2Icon className="size-3.5" />
            <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
              Scripts
            </span>
            <ChevronDownIcon className="size-3.5" />
          </Button>
        }
      />
      <MenuPopup align="end">
        {scripts.map((script) => (
          <MenuItem
            key={script.name}
            onClick={() => onRunScript(`${packageManager} run ${script.name}`)}
          >
            <span className="truncate">{script.name}</span>
            <span className="ms-auto truncate text-xs text-muted-foreground">{script.command}</span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
});
