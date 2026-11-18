import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";

const LATEST_PHOTO_ACTION: MenuAction = {
  id: "latest",
  title: "Attach Latest Photo",
  image: "clock",
};
const PHOTO_LIBRARY_ACTION: MenuAction = { id: "photos", title: "Photo Library", image: "photo" };
const FILES_ACTION: MenuAction = { id: "files", title: "Choose Files", image: "folder" };

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  readonly onAttachLatest?: () => Promise<void>;
}) {
  const { scale } = useAndroidControlSizing();
  const hasMenu = props.supportsFiles || props.onAttachLatest !== undefined;
  const button = (
    <Pressable
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={hasMenu ? undefined : () => void props.onPickMedia()}
    >
      <SymbolView
        name="plus"
        size={Math.round((props.size === "large" ? 26 : 20) * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (props.disabled || !hasMenu) {
    return button;
  }

  const actions = [
    ...(props.onAttachLatest ? [LATEST_PHOTO_ACTION] : []),
    PHOTO_LIBRARY_ACTION,
    ...(props.supportsFiles ? [FILES_ACTION] : []),
  ];

  return (
    <Menu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "latest") {
          void props.onAttachLatest?.();
        } else if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        }
      }}
    >
      {button}
    </Menu>
  );
}
