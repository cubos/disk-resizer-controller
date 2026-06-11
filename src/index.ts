import * as Sentry from "@sentry/node";
import axios from "axios";
import axiosRetry from "axios-retry";
import { Namespace, PersistentVolumeClaim, Pod, StorageClass } from "kubesdk";

const hasSentry = Boolean(process.env.SENTRY_DSN);

if (hasSentry) {
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
	});
}

axiosRetry(axios, { retries: 20, retryDelay: axiosRetry.exponentialDelay });

export async function checkAndResize() {
	try {
		const storageClasses = await StorageClass.list();

		for (const storageClass of storageClasses) {
			if (!storageClass.spec.allowVolumeExpansion) {
				storageClass.spec.allowVolumeExpansion = true;
				await storageClass.save();
			}
		}

		for (const namespace of await Namespace.list()) {
			console.log("-", namespace.metadata.name);

			const pods = await Pod.list({ namespace: namespace.metadata.name });
			const pvcs = await PersistentVolumeClaim.list({
				namespace: namespace.metadata.name,
			});

			for (const pvc of pvcs) {
				if (pvc.spec.storageClassName && !storageClasses.find(sc => sc.metadata.name === pvc.spec.storageClassName)) {
					console.warn(`  StorageClass ${pvc.spec.storageClassName} not found. Skipped.`);

					if (process.env.SLACK_WEBHOOK_URL) {
						axios.post(process.env.SLACK_WEBHOOK_URL, {
							text: `*[${process.env.CLUSTER_NAME}]* O disco *${pvc.metadata.name}.${namespace.metadata.name}* não foi redimensionado pois a StorageClass *${pvc.spec.storageClassName}* não foi encontrada`,
						});
					}

					continue;
				}

				if (pvc.status.conditions?.find(cond => cond.type === "Resizing")?.status === "True") {
					// disk is already being resized
					continue;
				}

				if (pvc.metadata.annotations?.["devops.cubos.io/disable-disk-resizer"] === "true") {
					console.log(`  PVC ${pvc.metadata.name} has resizing disabled by annotation. Skipped.`);
					continue;
				}

				const pod = pods.find(
					p =>
						p.status.phase === "Running" &&
						p.spec.volumes?.some(vol => "persistentVolumeClaim" in vol && vol.persistentVolumeClaim.claimName === pvc.metadata.name),
				);

				if (!pod || pvc.status.phase !== "Bound") {
					continue;
				}

				const volume = pod.spec.volumes?.find(vol => "persistentVolumeClaim" in vol && vol.persistentVolumeClaim.claimName === pvc.metadata.name);

				if (!volume) {
					continue;
				}

				const mounts: { container: typeof pod.spec.containers[0]; mount: NonNullable<typeof pod.spec.containers[0]["volumeMounts"]>[0] }[] = [];

				for (const c of pod.spec.containers) {
					const containerMounts = c.volumeMounts?.filter(m => m.name === volume.name) ?? [];
					for (const m of containerMounts) {
						mounts.push({ container: c, mount: m });
					}
				}

				if (mounts.length === 0) {
					continue;
				}

				const readyMount = mounts.find(({ container }) =>
					pod.status.containerStatuses?.find(status => status.name === container.name)?.ready
				);

				if (!readyMount) {
					console.log(`  Pod ${pod.metadata.name} has no ready container with this volume. Skipped.`);
					continue;
				}

				const { container, mount } = readyMount;

				let dfResult;

				try {
					dfResult = (await pod.exec(container.name, ["/bin/sh", "-c", "df -P || (ln -s /proc/mounts /etc/mtab && df -P)"])).stdout.toString();
				} catch (e) {
					console.error(e);

					if (hasSentry) {
						Sentry.captureException(e);
					}

					continue;
				}

				let usedBytes: number | undefined;

				for (const dfLine of dfResult.split("\n")) {
					const [_device, capacity, used, _free, _percent, mountPath] = dfLine.split(/\s+/u);

					if (mountPath && (mount.mountPath === mountPath || (mountPath !== "/" && mount.mountPath.startsWith(mountPath + "/")))) {
						const capacityBytes = parseInt(capacity, 10) * 1024;

						usedBytes = parseInt(used, 10) * 1024;

						const percentUsed = usedBytes / capacityBytes;
						const Gi = 1024 * 1024 * 1024;

						console.log(
							`  ${pvc.metadata.name} (${(usedBytes / Gi).toFixed(2)}Gi / ${(capacityBytes / Gi).toFixed(2)}Gi ~ ${(percentUsed * 100).toFixed(2)}%)`,
						);

						if (percentUsed > 0.85) {
							const newSizeBytes = `${Math.ceil((capacityBytes * 1.1) / Gi)}Gi`;

							console.log("    UPGRADE from", pvc.status.capacity.storage, "to", newSizeBytes);

							if (process.env.SLACK_WEBHOOK_URL) {
								axios.post(process.env.SLACK_WEBHOOK_URL, {
									text: `*[${process.env.CLUSTER_NAME}]* O disco *${pvc.metadata.name}.${namespace.metadata.name}* foi redimensionado de *${pvc.status.capacity.storage}* para *${newSizeBytes}*`,
								});
							}

							pvc.spec.resources.requests.storage = newSizeBytes;
							await pvc.save();
						}
					}
				}

				if (!usedBytes) {
					continue;
				}
			}
		}

		console.log("✅");
	} catch (err) {
		console.error(err);

		if (process.env.SLACK_WEBHOOK_URL) {
			try {
				const errorMessageRaw = err instanceof Error ? err.stack || err.message : String(err);
				const errorMessage = errorMessageRaw.length > 3500 ? `${errorMessageRaw.slice(0, 3500)}\n…(truncated)` : errorMessageRaw;
				await axios.post(
					process.env.SLACK_WEBHOOK_URL,
					{
						text: `*[${process.env.CLUSTER_NAME ?? "unknown-cluster"}]* Falha crítica no disk-resizer-controller:\n\`\`\`${errorMessage}\`\`\``,
					},
					{ timeout: 5000 },
				);
			} catch (slackErr) {
				console.error("Failed to send Slack notification:", slackErr);
			}
		}

		if (hasSentry) {
			Sentry.captureException(err);

			Sentry.close(10000).finally(() => {
				process.exit(1);
			});
		} else {
			process.exit(1);
		}
	}
}
