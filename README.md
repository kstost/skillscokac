# skillscokac

CLI tool to install and manage Claude Code skills from [skills.cokac.com](https://skills.cokac.com)

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

## API Endpoints

This CLI communicates with the following endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/marketplace` | Fetch marketplace data to find skills |
| `GET /api/posts/{postId}/export-skill-zip` | Download skill ZIP package |
| `GET /api/collections/{collectionId}` | Fetch collection metadata and skills |

**Base URL**: `https://skills.cokac.com`

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

## License

ISC

## Support

For issues, questions, or contributions:
- Visit [skills.cokac.com](https://skills.cokac.com)
- GitHub Issues: [Report an issue](https://github.com/kstost/skillscokac/issues)

## Author

**코드깎는노인** <monogatree@gmail.com>

Website: [skills.cokac.com](https://skills.cokac.com)
