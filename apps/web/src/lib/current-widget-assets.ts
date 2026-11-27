export const currentWidgetAssets: {
  path: string;
  sourceSha256: string;
  framehost: { path: string; sha384: string } | null;
} = JSON.parse(process.env.TEMPL_WIDGET_ASSETS!);
