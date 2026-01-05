# skillscokac

CLI tool to install and manage Claude Code skills from [skills.cokac.com](https://skills.cokac.com)

[![npm version](https://img.shields.io/npm/v/skillscokac.svg)](https://www.npmjs.com/package/skillscokac)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

## Installation

No installation required! Use `npx` to run the CLI directly:

```bash
npx skillscokac [options]
```

## Usage

### Quick Install (Interactive)

```bash
npx skillscokac -i <skill-name>
```

The CLI will:
1. Fetch the skill from skills.cokac.com
2. Display skill information (name, description, author, version, files)
3. Prompt you to choose installation type
4. Install the skill files

### All Commands

| Command | Description |
|---------|-------------|
| `-i, --install-skill <skillName>` | Install a single skill |
| `-c, --install-collection <collectionId>` | Install all skills from a collection |
| `-d, --download <skillName> [path]` | Download a skill to a directory (defaults to current directory) |
| `-u, --upload <skillDir>` | Upload a new skill to skills.cokac.com (requires `--apikey`) |
| `-m, --uploadmodify <skillDir>` | Upload or update a skill (creates if new, updates if exists, requires `--apikey`) |
| `--apikey <key>` | API key for uploading/updating skills |
| `-l, --list-installed-skills` | List all installed skills |
| `-r, --remove-skill <skillName>` | Remove an installed skill (with confirmation) |
| `-f, --remove-skill-force <skillName>` | Remove a skill without confirmation |
| `-a, --remove-all-skills` | Remove all installed skills (with confirmation) |
| `-A, --remove-all-skills-force` | Remove all skills without confirmation |

### Examples

**Install a single skill:**
```bash
npx skillscokac -i my-awesome-skill
```

**Install a collection:**
```bash
npx skillscokac -c collection-id-here
```

**Download a skill to a specific directory:**
```bash
# Download to a specific path
npx skillscokac -d my-awesome-skill ./downloads

# Download to current directory (path is optional)
npx skillscokac -d my-awesome-skill
```

This will download the skill without installing it to Claude Code's skill directories.

**Upload a skill to skills.cokac.com:**
```bash
npx skillscokac --upload ./my-skill --apikey ck_live_xxxxx
```

This will upload your skill to the marketplace. Requires an API key from skills.cokac.com.

**Upload or update a skill:**
```bash
npx skillscokac --uploadmodify ./my-skill --apikey ck_live_xxxxx
# or use short option
npx skillscokac -m ./my-skill --apikey ck_live_xxxxx
```

This will create a new skill if it doesn't exist, or update it if it already exists. Perfect for maintaining and iterating on your skills.

**List installed skills:**
```bash
npx skillscokac -l
```

**Remove a skill:**
```bash
npx skillscokac -r my-awesome-skill
```

**Remove all skills:**
```bash
npx skillscokac -a
```

## Installation Locations

When installing, you'll be prompted to choose between:

### Personal Skills (Global)
- **Location**: `~/.claude/skills/<skill-name>/`
- **Scope**: Available in all Claude Code sessions across all projects
- **Use case**: Skills you want to use everywhere

### Project Skills (Local)
- **Location**: `.claude/skills/<skill-name>/` (in current directory)
- **Scope**: Available only in the current project
- **Use case**: Project-specific skills or testing before making them global

## Download to Custom Location

If you want to download a skill without installing it to Claude Code's skill directories, use the download command:

```bash
npx skillscokac -d <skill-name> [path]
```

The `path` parameter is optional and defaults to the current directory.

**Examples:**
```bash
# Download to current directory
npx skillscokac -d my-skill

# Download to specific path
npx skillscokac -d my-skill ./my-downloads

# Download to absolute path
npx skillscokac -d my-skill /path/to/directory
```

This will:
1. Fetch the skill from skills.cokac.com
2. Display skill information
3. Download all skill files to `<path>/my-skill/`
4. **Not** install it to Claude Code's skill directories

**Use cases:**
- Inspecting skill contents before installation
- Backing up skills locally
- Sharing skill files with team members
- Custom deployment workflows

## Upload Skills to Marketplace

You can upload your own skills to skills.cokac.com using the upload command:

```bash
# Upload a new skill (fails if skill name already exists)
npx skillscokac --upload <skillDir> --apikey <your-api-key>

# Upload or update a skill (creates new or updates existing)
npx skillscokac --uploadmodify <skillDir> --apikey <your-api-key>
```

### Requirements

1. **API Key**: Get your API key from [skills.cokac.com](https://skills.cokac.com) (format: `ck_live_xxxxx`)
2. **SKILL.md**: Your skill directory must contain a `SKILL.md` file with frontmatter:

```markdown
---
name: my-skill
description: A brief description of what this skill does
version: 1.0.0
---

# My Skill

Your skill instructions here...
```

### Upload Process

The CLI will:
1. Parse the `SKILL.md` file and extract metadata (name, description)
2. Create a new skill post on skills.cokac.com
3. Upload all additional files in the directory (excluding hidden files and common ignore patterns)
4. Return the skill URL

### Examples

**Upload a new skill:**
```bash
# Upload a skill from current directory
npx skillscokac --upload . --apikey ck_live_xxxxx

# Upload a skill from specific directory
npx skillscokac --upload ./skills/my-awesome-skill --apikey ck_live_xxxxx
```

**Upload or update a skill:**
```bash
# Create new skill or update if it exists
npx skillscokac --uploadmodify ./my-skill --apikey ck_live_xxxxx

# Short option
npx skillscokac -m ./my-skill --apikey ck_live_xxxxx
```

### Difference between --upload and --uploadmodify

| Feature | `--upload` | `--uploadmodify` |
|---------|------------|------------------|
| **Behavior** | Creates a new skill only | Creates new OR updates existing skill |
| **If skill exists** | ❌ Fails with error (409 Conflict) | ✅ Updates the existing skill |
| **If skill doesn't exist** | ✅ Creates new skill | ✅ Creates new skill |
| **Use case** | First-time upload | Maintaining and iterating on skills |
| **Update process** | N/A | Replaces all files atomically |

**When to use `--upload`:**
- First time publishing a skill
- When you want to ensure you're creating a brand new skill
- When duplicate skill names should be prevented

**When to use `--uploadmodify`:**
- Updating an existing skill with improvements
- Continuous development workflow
- When you want "create or update" behavior
- Maintaining published skills over time

### What Gets Uploaded

- **SKILL.md**: Main skill file (required, used as primary content)
- **Additional files**: Any other files in the directory (e.g., scripts, configs, examples)
- **Excluded**: Hidden files (`.git`, `.env`), `node_modules`, `__pycache__`

### API Key

To get an API key:
1. Visit [skills.cokac.com](https://skills.cokac.com)
2. Sign in to your account
3. Go to Settings → API Keys
4. Generate a new API key

## Using Installed Skills

After installation, use the skill in Claude Code with:

```bash
/<skill-name>
```

Run this slash command in your Claude Code session to execute the skill.

## Collection Installation

Collections allow you to install multiple related skills at once:

```bash
npx skillscokac -c <collection-id>
```

The CLI will:
1. Fetch collection metadata
2. Display all available skills in the collection
3. Confirm installation
4. Prompt for installation type (applies to all skills in collection)
5. Install all skills with progress feedback

## Skill Management

### Listing Installed Skills

View all installed skills with detailed information:

```bash
npx skillscokac -l
```

This shows:
- Personal skills (global) with their paths
- Project skills (local) with their paths
- Skill names, descriptions, and versions
- Total count of installed skills

### Removing Skills

**Interactive removal** (with confirmation):
```bash
npx skillscokac -r <skill-name>
```

If a skill is installed in both locations, you'll be asked where to remove it from.

**Force removal** (no confirmation):
```bash
npx skillscokac -f <skill-name>
```

Removes from all locations without prompting.

### Removing All Skills

**Interactive removal** (with confirmation):
```bash
npx skillscokac -a
```

Shows all skills that will be deleted and asks for confirmation.

**Force removal** (no confirmation):
```bash
npx skillscokac -A
```

Immediately removes all skills from all locations.

## What Gets Installed

When you install a skill, the CLI downloads and extracts:
- `SKILL.md` - Main skill file with YAML frontmatter metadata
- Additional files (if any) - Supporting files in their original directory structure
- All files are extracted from a ZIP package served by the marketplace

## Requirements

- **Node.js**: 14.0.0 or higher
- **Claude Code**: Installed and configured

## Development

### Local Testing

```bash
# Clone the repository
git clone https://github.com/kstost/skillscokac.git
cd skillscokac

# Install dependencies
npm install

# Test locally
node bin/skillscokac.js -i <skill-name>
```

### Project Structure

```
skillscokac/
├── bin/
│   └── skillscokac.js    # Main CLI implementation
├── package.json          # Project metadata and dependencies
├── package-lock.json     # Dependency version lock
└── README.md            # Documentation (this file)
```

### Publishing to npm

```bash
npm publish
```

## Technologies Used

- **commander** - CLI command parsing and argument handling
- **axios** - HTTP requests to skills.cokac.com API
- **inquirer** - Interactive prompts for user input
- **chalk** - Terminal text styling and colors
- **ora** - Loading spinners and progress indicators
- **adm-zip** - ZIP file extraction
- **boxen** - Terminal UI boxes for skill listings
- **yaml** - YAML frontmatter parsing from SKILL.md

## Security

Version 1.5.0 introduces comprehensive security enhancements to protect against various attack vectors:

### Security Features

**YAML Parsing Protection**
- Automatic YAML frontmatter preprocessing with special character handling
- Protection against YAML bombs (Billion Laughs attack)
- Frontmatter size limits (10KB max)
- Alias expansion limits (max 10 aliases)
- Strict YAML parsing with unique key validation

**Zip Bomb Protection**
- Compression ratio validation (max 100:1 ratio)
- Individual file size limits (10MB max)
- Total package size limits (100MB max)
- Early detection of suspicious compression patterns

**Path Traversal Protection**
- ZIP entry name validation
- Absolute path rejection
- Path traversal attempt detection (`..` sequences)
- Null byte filename protection

**Input Validation**
- Collection ID validation (alphanumeric with hyphens/underscores only)
- Skill name validation from API responses
- Network request validation (content-type, redirect limits)
- ReDoS (Regular Expression Denial of Service) protection

**File Content Validation**
- SKILL.md size validation before and after reading
- UTF-8 encoding validation
- Maximum line length limits (2000 chars)
- Maximum line count limits (1000 lines)

### Reporting Security Issues

If you discover a security vulnerability, please email: monogatree@gmail.com

## Changelog

### v1.5.0 (2026-01-05)

**Security Enhancements:**
- Added comprehensive YAML bomb protection with alias limits
- Implemented ZIP bomb detection with compression ratio checks
- Enhanced path traversal protection for ZIP entries
- Added ReDoS (Regular Expression Denial of Service) protection
- Implemented strict input validation for collection IDs and skill names
- Added file content size validation
- Enhanced network request validation with content-type checks

**Improvements:**
- Automatic YAML frontmatter preprocessing for special characters
- Better error messages for invalid inputs
- Improved handling of malformed SKILL.md files

### v1.4.3 and earlier

Previous versions available on [npm](https://www.npmjs.com/package/skillscokac).

## License

ISC

## Support

For issues, questions, or contributions:
- Visit [skills.cokac.com](https://skills.cokac.com)
- GitHub Issues: [Report an issue](https://github.com/kstost/skillscokac/issues)

## Author

**코드깎는노인** <monogatree@gmail.com>

Website: [skills.cokac.com](https://skills.cokac.com)
