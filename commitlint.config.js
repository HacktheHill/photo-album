// Commit messages follow Conventional Commits: https://www.conventionalcommits.org/
export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		// Allow longer descriptive bodies and footers such as Co-Authored-By lines.
		"body-max-line-length": [0],
		"footer-max-line-length": [0],
	},
};
