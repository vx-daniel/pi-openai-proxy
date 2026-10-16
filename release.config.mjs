export default {
	branches: ["main"],
	plugins: [
		"@semantic-release/commit-analyzer",
		"@semantic-release/release-notes-generator",
		[
			"@semantic-release/changelog",
			{
				changelogFile: "CHANGELOG.md",
			},
		],
		[
			"@semantic-release/npm",
			{
				npmPublish: true,
				pkgRoot: ".",
			},
		],
		[
			"@semantic-release/github",
			{
				successComment: false,
				failComment: false,
				releasedLabels: false,
			},
		],
		[
			"@semantic-release/git",
			{
				assets: ["package.json", "pnpm-lock.yaml", "CHANGELOG.md"],
				// oxlint-disable-next-line no-template-curly-in-string -- semantic-release lodash template, not a JS template literal
				message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
	],
};
