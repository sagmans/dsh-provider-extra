#!/usr/bin/env bash
# Shared stack checks for tool version floors, shell scripts, and Python
# helpers. Called by both pre-commit hooks (against a staged index copy) and
# package scripts (at pre-push), so tool pins, scope, and flags stay in one
# place and every missing, stale, or overridden binary fails closed.
set -euo pipefail

# shellcheck source=.githooks/lib/tools.sh
. ".githooks/lib/tools.sh"

readonly MISE_CONFIG='mise.toml'
readonly PACKAGE_MANIFEST='package.json'
readonly TEMPLATE_SETUP='scripts/setup-hooks'
readonly MISE_TOOLS=(node shellcheck shfmt uv)
readonly SHELLCHECK_FLAGS=(--norc --external-sources --source-path=SCRIPTDIR:. --severity=style)
readonly SHFMT_FLAGS=(-d -i 0)
readonly UV_RUN_FLAGS=(--locked --quiet --managed-python --no-python-downloads)
readonly RUFF_FORMAT_FLAGS=(format --check --no-cache --config pyproject.toml .)
readonly RUFF_CHECK_FLAGS=(check --no-cache --config pyproject.toml .)
readonly MYPY_FLAGS=(--config-file pyproject.toml --no-incremental --cache-dir=/dev/null)
readonly FIND_PRUNE_DIRS=(./.git ./node_modules ./.venv)
# Prevent mise shims from triggering unprompted network installs during floor checks.
readonly MISE_NO_AUTOINSTALL_ENV=(
	MISE_AUTO_INSTALL=0
	MISE_NOT_FOUND_AUTO_INSTALL=0
	MISE_EXEC_AUTO_INSTALL=0
	MISE_YES=0
)
# Scrub ambient overrides so caller environment variables cannot skip lockfile
# sync, select system Python, or redirect caches/venvs outside the checked tree.
readonly UV_SCRUB_ENV=(
	-u MYPYPATH
	-u UV_CONFIG_FILE
	-u UV_DEFAULT_INDEX
	-u UV_ENV_FILE
	-u UV_EXCLUDE_NEWER
	-u UV_EXTRA_INDEX_URL
	-u UV_FIND_LINKS
	-u UV_FROZEN
	-u UV_INDEX
	-u UV_INDEX_URL
	-u UV_ISOLATED
	-u UV_LOCKED
	-u UV_NO_CONFIG
	-u UV_NO_DEFAULT_GROUPS
	-u UV_NO_DEV
	-u UV_NO_GROUP
	-u UV_NO_PROJECT
	-u UV_NO_SYNC
	-u UV_OFFLINE
	-u UV_PROJECT
	-u UV_PROJECT_ENVIRONMENT
	-u UV_PYTHON
	-u UV_PYTHON_DOWNLOADS
	-u UV_PYTHON_PREFERENCE
)

VENV_DIR=''
STACK_TMP_FILE=''

cleanup_stack_tmp() {
	case "$STACK_TMP_FILE" in
	*/stack-shell-paths.*) rm -f -- "$STACK_TMP_FILE" ;;
	esac
}
trap cleanup_stack_tmp EXIT
trap 'cleanup_stack_tmp; exit 130' INT
trap 'cleanup_stack_tmp; exit 143' TERM

# Read one pinned version from [tools] in mise.toml so version floors have a
# single source of truth. Pure POSIX awk works on both macOS BSD awk and gawk.
mise_tool_version() {
	local tool="$1" version
	if [ ! -f "$MISE_CONFIG" ]; then
		echo "stack-checks: $MISE_CONFIG not found" >&2
		return 1
	fi
	version=$(awk -v key="$tool" '
		/^\[tools\][[:space:]]*(#.*)?$/ { in_tools = 1; next }
		/^\[/ { in_tools = 0; next }
		in_tools {
			line = $0
			sub(/[[:space:]]*#.*$/, "", line)
			if (line ~ "^[[:space:]]*" key "[[:space:]]*=") {
				if (line !~ "^[[:space:]]*" key "[[:space:]]*=[[:space:]]*\"[0-9]+\\.[0-9]+\\.[0-9]+\"[[:space:]]*$") {
					bad = 1
					exit 1
				}
				sub(/^[^"]*"/, "", line)
				sub(/".*$/, "", line)
				val = line
				count++
			}
		}
		END {
			if (bad || count != 1) exit 1
			print val
		}
	' "$MISE_CONFIG") || {
		echo "stack-checks: exact unique X.Y.Z pin for $tool missing or invalid in $MISE_CONFIG" >&2
		return 1
	}
	printf '%s\n' "$version"
}

# Verify a tool is on PATH, exits 0 on --version without mise auto-install,
# prints an exact X.Y.Z version on stdout (first version-like token only, never
# stderr), and meets the pinned floor.
require_pinned_tool() {
	local check="$1" tool="$2" min="$3" hint="$4" out version
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "❌ $check: $tool not found; $hint" >&2
		return 1
	fi
	if ! out=$(env "${MISE_NO_AUTOINSTALL_ENV[@]}" "$tool" --version 2>/dev/null); then
		echo "❌ $check: $tool --version failed; $hint" >&2
		return 1
	fi
	version=$(
		awk '
		{
			if (match($0, /[0-9]+\.[0-9]+(\.[0-9]+)*([-+][A-Za-z0-9._-]+)?/)) {
				tok = substr($0, RSTART, RLENGTH)
				if (tok ~ /^[0-9]+\.[0-9]+\.[0-9]+$/) {
					print tok
					found = 1
					exit 0
				}
				exit 1
			}
		}
		END { if (!found) exit 1 }
	' <<EOF
$out
EOF
	) || {
		echo "❌ $check: cannot read exact X.Y.Z version for $tool from stdout; $hint" >&2
		return 1
	}
	if ! version_ge "$version" "$min"; then
		echo "❌ $check: $tool $version is older than the minimum $min; $hint" >&2
		return 1
	fi
}

require_mise_tool() {
	local check="$1" tool="$2" min
	min=$(mise_tool_version "$tool") || return 1
	require_pinned_tool "$check" "$tool" "$min" \
		"install $tool >= $min (see $MISE_CONFIG), e.g. mise install $tool"
}

# Select repo-owned shell scripts while skipping shared hook template files in
# .githooks/lib/ (owned by template sync).
is_repo_shell_path() {
	case "$1" in
	.githooks/lib/*) return 1 ;;
	.githooks/*.d/* | "$TEMPLATE_SETUP") return 0 ;;
	esac
	has_extension "$1" ' sh bash '
}

# Classify NUL-delimited staged paths so pre-commit runs only the checks a
# commit can affect while keeping shell scope single-sourced here.
staged_targets() {
	local staged_file="${1:-}" path run_py=0 run_sh=0
	if [ -z "$staged_file" ] || [ ! -r "$staged_file" ]; then
		echo "stack-checks: staged path list missing or unreadable" >&2
		return 1
	fi
	while IFS= read -r -d '' path; do
		case "$path" in
		"$MISE_CONFIG" | scripts/stack-checks.sh | .githooks/lib/tools.sh)
			run_py=1
			run_sh=1
			;;
		pyproject.toml | uv.lock)
			run_py=1
			;;
		*)
			if has_extension "$path" ' py '; then
				run_py=1
			fi
			if is_repo_shell_path "$path"; then
				run_sh=1
			fi
			;;
		esac
	done <"$staged_file"
	if [ "$run_py" -eq 1 ]; then
		printf 'py\n'
	fi
	if [ "$run_sh" -eq 1 ]; then
		printf 'sh\n'
	fi
}

# Read the pnpm pin from package.json packageManager so pnpm stays single-sourced
# with pnpm's own manager and the release workflow.
package_manager_pnpm_version() {
	local version
	version=$(env "${MISE_NO_AUTOINSTALL_ENV[@]}" node -e '
		const fs = require("node:fs");
		const pm = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).packageManager;
		const m = typeof pm === "string" ? /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(pm) : null;
		if (!m) process.exit(1);
		console.log(m[1]);
	' "$PACKAGE_MANIFEST") || {
		echo "stack-checks: pnpm pin missing or invalid in $PACKAGE_MANIFEST packageManager" >&2
		return 1
	}
	printf '%s\n' "$version"
}

check_tools() {
	local tool pnpm_min
	for tool in "${MISE_TOOLS[@]}"; do
		require_mise_tool stack-tools "$tool" || return 1
	done
	pnpm_min=$(package_manager_pnpm_version) || return 1
	require_pinned_tool stack-tools pnpm "$pnpm_min" \
		"install pnpm >= $pnpm_min (see $PACKAGE_MANIFEST packageManager)"
}

check_shell() {
	local path dir
	local -a lint_files=() fmt_files=() prune_args=()
	require_mise_tool shell-lint shellcheck
	require_mise_tool shell-lint shfmt

	STACK_TMP_FILE=$(mktemp "${TMPDIR:-/tmp}/stack-shell-paths.XXXXXX") || return 1
	# In a git checkout, check only tracked files so untracked local helpers do
	# not fail the gate; in a pre-commit scratch copy (no .git), every file came
	# from the staged index. Write to a file so git/find failures fail closed.
	if [ -e .git ]; then
		git ls-files -z >"$STACK_TMP_FILE" || return 1
	else
		for dir in "${FIND_PRUNE_DIRS[@]}"; do
			if [ "${#prune_args[@]}" -gt 0 ]; then
				prune_args+=(-o)
			fi
			prune_args+=(-path "$dir")
		done
		find . \( "${prune_args[@]}" \) -prune -o -type f -print0 >"$STACK_TMP_FILE" || return 1
	fi

	while IFS= read -r -d '' path; do
		path=${path#./}
		is_repo_shell_path "$path" || continue
		lint_files+=("$path")
		if [ "$path" != "$TEMPLATE_SETUP" ]; then
			fmt_files+=("$path")
		fi
	done <"$STACK_TMP_FILE"

	if [ "${#lint_files[@]}" -eq 0 ] || [ "${#fmt_files[@]}" -eq 0 ]; then
		echo "stack-checks: no repository shell scripts found" >&2
		return 1
	fi

	env -u SHELLCHECK_OPTS shellcheck "${SHELLCHECK_FLAGS[@]}" -- "${lint_files[@]}"
	shfmt "${SHFMT_FLAGS[@]}" -- "${fmt_files[@]}"
}

run_uv() {
	if [ -n "$VENV_DIR" ]; then
		env "${UV_SCRUB_ENV[@]}" UV_PROJECT_ENVIRONMENT="$VENV_DIR" uv run "${UV_RUN_FLAGS[@]}" "$@"
	else
		env "${UV_SCRUB_ENV[@]}" uv run "${UV_RUN_FLAGS[@]}" "$@"
	fi
}

check_py_lint() {
	require_mise_tool python-lint uv
	run_uv ruff "${RUFF_FORMAT_FLAGS[@]}"
	run_uv ruff "${RUFF_CHECK_FLAGS[@]}"
}

check_py_typecheck() {
	require_mise_tool python-typecheck uv
	run_uv mypy "${MYPY_FLAGS[@]}"
}

if [ "${1:-}" = '--venv' ]; then
	if [ "$#" -lt 2 ] || [ -z "$2" ]; then
		echo "stack-checks: --venv requires a non-empty path" >&2
		exit 2
	fi
	VENV_DIR="$2"
	shift 2
fi

case "${1:-}" in
tools) check_tools ;;
sh) check_shell ;;
py-lint) check_py_lint ;;
py-typecheck) check_py_typecheck ;;
staged-targets) staged_targets "${2:-}" ;;
*)
	echo "usage: $(basename -- "$0") [--venv <dir>] <tools|sh|py-lint|py-typecheck|staged-targets <file>>" >&2
	exit 2
	;;
esac
