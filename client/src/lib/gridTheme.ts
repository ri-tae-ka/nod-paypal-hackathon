import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

export const gridTheme = themeQuartz.withParams({
  accentColor: "#2b5fb4",
  borderColor: "#e3e8f0",
  headerBackgroundColor: "#f3f8ff",
  headerTextColor: "#1d3f78",
  oddRowBackgroundColor: "#fffdf3",
  rowHoverColor: "#e6f0ff",
  selectedRowBackgroundColor: "#e6f0ff",
  fontFamily: "inherit",
  fontSize: 14,
  wrapperBorderRadius: 10,
  valueChangeValueHighlightBackgroundColor: "#ffe08a",
});
