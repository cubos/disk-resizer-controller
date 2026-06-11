import { Controller } from "kubesdk";

import { checkAndResize } from "./index.js";

const controller = new Controller("disk-resizer");

controller.attachClusterPolicyRules([
	{
		apiGroups: [""],
		resources: ["namespaces", "pods"],
		verbs: ["list"],
	},

	{
		apiGroups: [""],
		resources: ["persistentvolumeclaims"],
		verbs: ["list", "update"],
	},

	{
		apiGroups: ["storage.k8s.io"],
		resources: ["storageclasses"],
		verbs: ["list", "update"],
	},

	{
		apiGroups: [""],
		resources: ["pods/exec"],
		verbs: ["create", "get"],
	},
]);

controller.attachSecretEnv("env", {
	CLUSTER_NAME: process.env.CLUSTER_NAME ?? "",
	SENTRY_DSN: process.env.SENTRY_DSN ?? "",
	SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL ?? "",
});

controller.addCronJob("check", "*/5 * * * *", checkAndResize);
controller.cli();
