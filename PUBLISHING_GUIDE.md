# Publishing Guide for Showy Extension

## ✅ Package Created Successfully

Your extension has been packaged as: **showy-0.1.0.vsix** (19.93 KB)

## Test Locally First

Before publishing to the marketplace, test the packaged extension:

```bash
code --install-extension showy-0.1.0.vsix
```

Then restart VS Code and test all features:
- Open a project
- Run "Showy: Open Project Map"
- Test tree view
- Test graph view
- Test dependency detection
- Test circular dependency warnings

## Publishing to VS Code Marketplace

### Step 1: Create a Publisher Account

1. Go to https://marketplace.visualstudio.com/manage
2. Sign in with your Microsoft/GitHub account
3. Click "Create publisher"
4. Choose a publisher ID (this will be your namespace)
5. Fill in your details

### Step 2: Get a Personal Access Token

1. Go to https://dev.azure.com/
2. Click on your profile → Security → Personal Access Tokens
3. Click "New Token"
4. Name: "VS Code Publishing"
5. Organization: All accessible organizations
6. Scopes: Select "Marketplace" → "Manage"
7. Click "Create" and **copy the token** (you won't see it again!)

### Step 3: Login with vsce

```bash
vsce login omob2022-commits
```

When prompted, paste your Personal Access Token.

### Step 4: Update Publisher Name (if needed)

If your publisher ID is different from "omob2022-commits", update `package.json`:

```json
"publisher": "your-actual-publisher-id"
```

Then repackage:

```bash
vsce package
```

### Step 5: Publish

```bash
vsce publish
```

This will:
- Upload your extension to the marketplace
- Make it available within minutes
- Users can install it via "Extensions" in VS Code

## Alternative: Manual Upload

If you prefer not to use the command line:

1. Go to https://marketplace.visualstudio.com/manage
2. Click your publisher
3. Click "New extension" → "Visual Studio Code"
4. Drag and drop `showy-0.1.0.vsix`
5. Click "Upload"

## After Publishing

### Update Your Repository

Add a badge to your README.md:

```markdown
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/omob2022-commits.showy)](https://marketplace.visualstudio.com/items?itemName=omob2022-commits.showy)
```

### Share Your Extension

Your extension will be available at:
```
https://marketplace.visualstudio.com/items?itemName=omob2022-commits.showy
```

## Future Updates

When you want to publish an update:

1. Update version in `package.json` (e.g., 0.1.0 → 0.1.1)
2. Update `CHANGELOG.md` with changes
3. Compile: `npm run compile`
4. Package: `vsce package`
5. Publish: `vsce publish`

Or use version bump commands:
```bash
vsce publish patch  # 0.1.0 → 0.1.1
vsce publish minor  # 0.1.0 → 0.2.0
vsce publish major  # 0.1.0 → 1.0.0
```

## Troubleshooting

### "Publisher not found"
- Make sure you've created a publisher account
- Verify the publisher name in package.json matches your account

### "Authentication failed"
- Your PAT may have expired
- Create a new token and login again: `vsce login your-publisher`

### "Extension already exists"
- You're trying to publish a version that already exists
- Bump the version number in package.json

## Resources

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Extension Marketplace](https://marketplace.visualstudio.com/)
- [vsce Documentation](https://github.com/microsoft/vscode-vsce)

---

**Your extension is ready to publish! 🚀**
