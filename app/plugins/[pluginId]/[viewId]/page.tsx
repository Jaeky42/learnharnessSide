import { PluginViewScreen } from "@/components/plugin-view";
// Side-tutor fork: on a phone a plugin that isn't phone-ready shows one sentence instead.
import { PhonePluginPage } from "@/components/phone/phone-plugin-page";

export default async function PluginPage({ params }: { params: Promise<{ pluginId: string; viewId: string }> }) {
	const { pluginId, viewId } = await params;
	return <PhonePluginPage pluginId={pluginId}><PluginViewScreen pluginId={pluginId} viewId={viewId} /></PhonePluginPage>;
}
