﻿const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const console = require('console');
const { execSync } = require('child_process');
const Parser = require('./parser');
const Terragrunt = require('./terragrunt');

let linkDecorator = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline',
    overviewRulerColor: 'blue',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    cursor: 'pointer',
    color: '#FFD580',
    after: {
        fontWeight: 'bold',
    },
    light: {
        color: 'darkorange',
        borderColor: 'darkblue',
    },
    dark: {
        color: 'lightorange',
        borderColor: 'lightblue',
    },
});

let lhsDecorator = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: 'blue',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    cursor: 'pointer',
    color: '#FFD580',
    after: {
        fontWeight: 'bold',
    },
    light: {
        color: 'violet',
        borderColor: 'lightgreen',
    },
    dark: {
        color: 'violet',
        borderColor: 'lightgreen',
    },
});

let rhsDecorator = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: 'blue',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    cursor: 'pointer',
    color: '#FFD580',
    after: {
        fontWeight: 'bold',
    },
    light: {
        color: 'lightgreen',
        borderColor: 'lightorange',
    },
    dark: {
        color: 'lightgreen',
        borderColor: 'lightorange',
    },
});

class TerragruntNav {
    patterns = [
        {
            pattern: /(source\s*=\s*)"git::(ssh:\/\/|)(.*)\/\/([^#\r\n"?]+)(\?ref=(.*)")/,
            location: 'git',
        },
        {
            pattern: /((source|config_path)\s*=\s*")([^#\r\n"]+)/,
            location: 'local',
        },
        {
            pattern: /((find_in_parent_folders|file|read_terragrunt_config)\(")([^#\r\n"]+)/,
            location: 'enclosed',
        },
    ];
    replaceStrings = true;
    replacementStrings = [];
    quickReplaceStringsCount = 1;
    getCodePath = '';
    tfInfo = {
        freshStart: true,
        printTree: false,
        traverse: Parser.traverse,
        doEval: true,
        tfCache: null,
    };
    lastModulePath = null;
    terragruntRepoCacheWSFolderExists = false;
    addTerragruntCacheToWorkspace = true;
    tfCache = {};
    cacheAccessTimes = new Map();
    maxCacheSize = 10;

    constructor(context) {
        const repoCacheDir = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
        this.terragruntRepoCache = path.join(repoCacheDir, '.terragrunt-repo-cache');
        this.lastClonedMap = new Map();
        let config = vscode.workspace.getConfiguration('terragrunt-navigator');

        const lastClonedMapConfig = config.get('lastClonedMap');
        if (lastClonedMapConfig) {
            this.lastClonedMap = new Map(Object.entries(lastClonedMapConfig));
        }

        let featureToggles = getFeatureTogglesConfig();
        let setDefaults = false;
        this.replaceStrings = featureToggles['ReplaceStrings'];
        if (this.replaceStrings === undefined) {
            this.replaceStrings = true;
            setDefaults = true;
        }
        this.addTerragruntCacheToWorkspace = featureToggles['AddTerragruntCacheToWorkspace'];
        if (this.addTerragruntCacheToWorkspace === undefined) {
            this.addTerragruntCacheToWorkspace = true;
            setDefaults = true;
        }
        if (setDefaults) {
            this.updateSetting(config, 'featureToggles', featureToggles);
        }

        this.replacementStrings = config.get('replacementStrings');
        if (this.replacementStrings === undefined || this.replacementStrings.length === 0) {
            this.replacementStrings.push({ find: '', replace: '' });
        }

        this.maxCacheSize = config.get('maxCacheSize');
        if (this.maxCacheSize === undefined) {
            this.maxCacheSize = 10;
            this.updateSetting(config, 'maxCacheSize', this.maxCacheSize);
        }

        this.quickReplaceStringsCount = config.get('quickReplaceStringsCount');
        if (this.quickReplaceStringsCount === undefined || this.quickReplaceStringsCount < 1) {
            this.quickReplaceStringsCount = 1;
            this.updateSetting(config, 'quickReplaceStringsCount', this.quickReplaceStringsCount);
        }

        const extensionPath = context.extensionPath;
        this.getCodePath = path.join(extensionPath, 'get-code.sh');

        for (let folder of vscode.workspace.workspaceFolders) {
            if (folder.uri.fsPath.endsWith('.terragrunt-repo-cache')) {
                this.terragruntRepoCache = folder.uri.fsPath;
                this.terragruntRepoCacheWSFolderExists = true;
                break;
            }
        }

        if (!this.terragruntRepoCacheWSFolderExists) {
            if (!fs.existsSync(this.terragruntRepoCache)) {
                fs.mkdirSync(this.terragruntRepoCache);
                console.log('Created terragrunt repo cache directory');
            }
        }
    }

    updateSetting(config, key, value) {
        config.update(key, value, vscode.ConfigurationTarget.Global);
    }

    provideDocumentLinks(document, token) {
        let links = [];
        let linkDecorations = [];
        let lhsDecorations = [];
        let rhsDecorations = [];

        console.log('Providing document links for ' + document.uri.fsPath);
        if (!document) {
            return;
        }

        this.updateConfigs();
        try {
            this.decorateKeys(lhsDecorations, this.tfInfo.configs, this.tfInfo.ranges);
        } catch (e) {
            console.log('Failed to decorate keys: ' + e);
        }

        try {
            this.decorateValues(document, rhsDecorations, linkDecorations, links);
        } catch (e) {
            console.log('Failed to decorate values: ' + e);
        }

        if (vscode.window.activeTextEditor) {
            vscode.window.activeTextEditor.setDecorations(linkDecorator, linkDecorations);
            vscode.window.activeTextEditor.setDecorations(lhsDecorator, lhsDecorations);
            vscode.window.activeTextEditor.setDecorations(rhsDecorator, rhsDecorations);
            vscode.window.activeTextEditor.setDocumentLinks(links);
        }
        return links;
    }

    decorateKeys(decorations, configs = {}, ranges = {}) {
        if (configs === null || configs === undefined) {
            return;
        }

        for (let key in ranges) {
            if (!configs?.hasOwnProperty(key)) {
                continue;
            }
            this.processKey(decorations, configs[key], ranges[key]);
        }
    }

    processKey(decorations, value, range) {
        if (Array.isArray(value) && Array.isArray(range)) {
            this.updateDecorations(decorations, value, range[range.length - 1]);
            this.processArray(decorations, value, range);
        } else if (typeof value === 'object' && value !== null) {
            this.updateDecorations(decorations, value, range);
            this.decorateKeys(decorations, value, range);
        } else {
            this.updateDecorations(decorations, value, range);
        }
    }

    processArray(decorations, valueArray, rangeArray) {
        for (let i = 0; i < valueArray.length; i++) {
            let v = valueArray[i];
            let r = rangeArray[i];
            if (typeof v === 'object' && v !== null) {
                this.decorateKeys(decorations, v, r);
            } else {
                this.updateDecorations(decorations, v, r);
            }
        }
    }

    updateDecorations(decorations, value, range) {
        if (range.hasOwnProperty('__range')) {
            let r = range.__range;
            let message = new vscode.MarkdownString(`\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
            message.isTrusted = true;
            decorations.push({
                range: new vscode.Range(r.sl, r.sc, r.el, r.ec),
                hoverMessage: message,
            });
        }
    }

    decorateValues(document, rhsDecorations, linkDecorations, links) {
        for (let line = 0; line < document.lineCount; line++) {
            let textLine = document.lineAt(line);

            try {
                if (this.decorateLinks(linkDecorations, links, textLine.text, line)) {
                    continue;
                }
            } catch (e) {
                console.log('Failed to decorate links for ' + textLine.text + ': ' + e);
                continue;
            }

            let pattern = /\${(local|var|dependency)\.[^}]+}|(local|var|dependency)\.[a-zA-Z_][a-zA-Z0-9_.*]+/g;
            let match = textLine.text.match(pattern);
            if (!match) {
                continue;
            }
            try {
                let position = 0;
                for (const element of match) {
                    let str = element.trim();
                    let value = Parser.evalExpression(str, this.tfInfo, true);
                    const sc = textLine.text.indexOf(element, position);
                    position = sc + element.length;
                    let range = new vscode.Range(line, sc, line, position);
                    let message = new vscode.MarkdownString(`\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
                    message.isTrusted = true;
                    rhsDecorations.push({ range: range, hoverMessage: message });
                }
            } catch (e) {
                console.log('Failed for ' + textLine.text + ' ' + e);
            }
        }
    }

    decorateLinks(linkDecorations, links, text, line) {
        let match = null;
        let location = null;

        for (let pattern of this.patterns) {
            match = text.match(pattern.pattern);
            location = pattern.location;
            if (match) {
                break;
            }
        }

        if (match) {
            let result = this.getPathInfo(match, line, location);
            if (result) {
                const link = new vscode.DocumentLink(result.range, vscode.Uri.parse(result.path));
                links.push(link);
                let message = `[${result.path}](${result.path}): Ctrl+click to Open`;
                linkDecorations.push({ range: result.range, hoverMessage: message });
            }
            return true;
        }

        return false;
    }

    updateConfigs() {
        const filePath = vscode.window.activeTextEditor.document.uri.fsPath;
        try {
            const baseDir = path.dirname(filePath);
            let fileName = path.basename(filePath);
            this.tfInfo.useCache = !fileName.endsWith('.hcl');

            if (this.tfInfo.useCache && baseDir != this.lastModulePath) {
                this.tfInfo.configs = {};
                this.tfInfo.ranges = {};
                this.tfInfo.doEval = false;

                console.log('Parsing module in ' + baseDir + 'for file ' + fileName);

                const files = fs.readdirSync(baseDir).filter((file) => file.endsWith('.tf'));
                for (const file of files) {
                    const fullPath = path.join(baseDir, file);
                    this.tfInfo.freshStart = true;
                    Terragrunt.read_terragrunt_config.apply(this.tfInfo, [fullPath, this.tfInfo]);
                }
                this.tfCache[baseDir] = JSON.parse(JSON.stringify(this.tfInfo));
                this.lastModulePath = baseDir;

                this.cacheAccessTimes.set(baseDir, Date.now());
                this.limitCacheSize();
            }

            let inputJson = path.join(baseDir, 'input.json');
            if (fs.existsSync(inputJson)) {
                console.log('Reading input file: ' + inputJson);
                let jsonData = fs.readFileSync(inputJson, 'utf8');
                try {
                    let inputs = JSON.parse(jsonData);
                    this.tfInfo.inputs = inputs['inputs'];
                } catch (e) {
                    console.error('Failed to parse input.json: ' + e);
                }
            }

            if (this.tfInfo.useCache) {
                this.tfInfo.tfCache = this.tfCache[baseDir];
                Parser.updateCacheWithVars(this.tfInfo.tfCache, this.tfInfo.inputs);
            } else {
                this.tfInfo.tfCache = null;
            }

            // Clear the configs to avoid appending to the configs
            this.tfInfo.configs = {};
            this.tfInfo.ranges = {};
            this.tfInfo.doEval = true;
            this.tfInfo.freshStart = true;
            Terragrunt.read_terragrunt_config.apply(this.tfInfo, [filePath, this.tfInfo]);
        } catch (e) {
            console.log('Failed to read terragrunt config for ' + filePath + ': ' + e);
        }
    }

    limitCacheSize() {
        if (this.cacheAccessTimes.size > this.maxCacheSize) {
            // Sort cache directories by access time
            const sortedCacheDirs = Array.from(this.cacheAccessTimes.entries()).sort((a, b) => a[1] - b[1]);
            // Remove the oldest entries
            while (this.cacheAccessTimes.size > this.maxCacheSize) {
                const oldestEntry = sortedCacheDirs.shift();
                if (oldestEntry) {
                    const [oldestDir] = oldestEntry;
                    delete this.tfCache[oldestDir];
                    this.cacheAccessTimes.delete(oldestDir);
                    console.log(`Removed oldest cache directory: ${oldestDir}`);
                }
            }
        }
    }

    getPathInfo(match, line, location) {
        let srcPath = '';
        let range = null;
        srcPath = match[3].trim();
        if (location === 'enclosed') {
            let func = match[2].trim();
            let funcArgs = match[3].trim();
            if (func === 'find_in_parent_folders') {
                srcPath = Terragrunt.find_in_parent_folders.apply(this.tfInfo, [funcArgs]);
                if (!srcPath) {
                    return null;
                }
            }
        }

        range = new vscode.Range(line, match.index + match[1].length, line, match.index + match[0].trimEnd().length);

        if (this.replaceStrings && typeof srcPath === 'string') {
            for (let replacement of this.replacementStrings) {
                srcPath = srcPath.replace(replacement.find, replacement.replace);
            }
        }
        srcPath = Parser.evalExpression(`"${srcPath}"`, this.tfInfo);

        return { path: srcPath, range };
    }

    // Open the file on ctrl+click or F12
    provideDefinition(document, position, token) {
        let line = document.lineAt(position.line);
        let location = null;
        let match = null;
        for (let pattern of this.patterns) {
            match = line.text.match(pattern.pattern);
            location = pattern.location;
            if (match) {
                break;
            }
        }

        if (!match) {
            return null;
        }

        this.updateConfigs();

        let result = this.getPathInfo(match, position.line, location);
        if (!result) {
            return null;
        }

        let uri = null;
        if (location === 'git') {
            if (this.addTerragruntCacheToWorkspace && !this.terragruntRepoCacheWSFolderExists) {
                vscode.workspace.updateWorkspaceFolders(0, 0, {
                    uri: vscode.Uri.file(this.terragruntRepoCache),
                });
            }
            let { repoUrl, ref, urlPath, modulePath, repoDir } = this.getRepoDetails(match);
            uri = this.cloneRepo(repoUrl, ref, urlPath, modulePath, repoDir);
        } else {
            uri = vscode.Uri.file(result.path);
        }

        if (uri && fs.lstatSync(uri.fsPath).isDirectory()) {
            uri = this.openFileFromDirectory(uri);
        }

        this.tfInfo.inputs = this.tfInfo.configs.inputs;
        return new vscode.Location(uri, new vscode.Position(0, 0));
    }

    openFileFromDirectory(uri) {
        if (uri && fs.lstatSync(uri.fsPath).isDirectory()) {
            let dir = uri.fsPath;
            const files = fs.readdirSync(dir);
            if (files.length === 0) {
                return null;
            }
            let fileToOpen = null;
            let firstChoiseList = ['terragrunt.hcl', 'main.tf'];
            for (let file of firstChoiseList) {
                if (files.includes(file)) {
                    fileToOpen = path.join(dir, file);
                    break;
                }
            }
            if (!fileToOpen) {
                fileToOpen = path.join(dir, files[0]);
            }
            uri = vscode.Uri.file(fileToOpen);
            vscode.commands.executeCommand('revealInExplorer', uri);
        }
        return uri;
    }

    getRepoDetails(match) {
        let repoUrl = match[3];
        let ref = Parser.evalExpression(match[6], this.tfInfo);
        let modulePath = match[4].trim();

        let url = null;
        try {
            let tmpUrl = repoUrl;
            if (repoUrl.startsWith('git@')) {
                tmpUrl = repoUrl.replace(':', '/').replace('git@', 'https://');
            }
            url = new URL(tmpUrl.trim());
        } catch (e) {
            console.error('Failed to parse URL: ' + e);
            return null;
        }

        const urlPath = url.pathname.replace(/(^\/|\.git$)/g, '');
        if (repoUrl.startsWith('git@')) {
            repoUrl = `git@${url.hostname}:${urlPath}`;
        }

        let repoName = urlPath.split('/').pop();
        let repoDir = this.findRepoDirInWorkspace(repoName);
        return { repoUrl, ref, urlPath, modulePath, repoDir };
    }

    findRepoDirInWorkspace(repoName) {
        let repoDir = null;
        console.log('Checking workspace folders for ' + repoName);
        if (vscode.workspace.workspaceFolders) {
            for (let folder of vscode.workspace.workspaceFolders) {
                if (folder.uri.fsPath.endsWith(repoName)) {
                    repoDir = folder.uri.fsPath;
                    break;
                }
            }
            if (repoDir == null) {
                console.log(`Didn't find ${repoName} in workspace folders. Checking one level deep`);
                repoDir = this.findRepoInSubdirectories(repoName);
            }
        }
        return repoDir;
    }

    findRepoInSubdirectories(repoName) {
        for (let folder of vscode.workspace.workspaceFolders) {
            console.log(`Checking in folder ${folder.uri.fsPath}`);
            const subdirs = fs
                .readdirSync(folder.uri.fsPath, { withFileTypes: true })
                .filter((dirent) => dirent.isDirectory())
                .map((dirent) => path.join(folder.uri.fsPath, dirent.name));
            for (let subdir of subdirs) {
                if (subdir.endsWith(repoName)) {
                    console.log(`Found ${repoName} in ${subdir}`);
                    return subdir;
                }
            }
        }
        return null;
    }

    cloneRepo(repoUrl, ref, urlPath, modulePath, repoDir) {
        let clone = true;
        if (repoDir) {
            clone = false;
        } else {
            repoDir = path.join(this.terragruntRepoCache, urlPath);
            const now = Date.now();
            if (
                fs.existsSync(repoDir) &&
                this.lastClonedMap.has(repoDir) &&
                now - this.lastClonedMap.get(repoDir) < 3000000
            ) {
                clone = false;
            } else {
                this.lastClonedMap.set(repoDir, now);
                let config = vscode.workspace.getConfiguration('terragrunt-navigator', null);
                this.updateSetting(config, 'lastClonedMap', Object.fromEntries(this.lastClonedMap));
            }
        }

        if (clone) {
            try {
                vscode.window.showInformationMessage(`Cloning ${repoUrl} to ${repoDir}`);
                let cmd = `${this.getCodePath} ${repoUrl} ${ref} ${repoDir}`;
                if (os.platform() === 'win32') {
                    cmd = `git-bash.exe ${cmd}`;
                } else {
                    cmd = `bash ${cmd}`;
                }
                execSync(cmd, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`exec error: ${error}`);
                        vscode.window.showInformationMessage(`Error cloning repository: ${error}`);
                    }
                    console.log(`Repo cloned. stdout: ${stdout}`);
                });
            } catch (error) {
                console.error(`exec error: ${error}`);
                vscode.window.showInformationMessage('Error cloning repository:', error);
            }
        }
        let dir = path.join(repoDir, modulePath);
        return vscode.Uri.file(dir);
    }
}

async function quickReplaceStringsCountCommand(terragruntNav) {
    let quickReplaceStringsCount = terragruntNav.quickReplaceStringsCount;
    let count = await vscode.window.showInputBox({
        prompt: 'Enter the number of strings to show for quick replacement',
        value: quickReplaceStringsCount.toString(),
    });

    if (count !== undefined) {
        let config = vscode.workspace.getConfiguration('terragrunt-navigator', null);
        await config.update('quickReplaceStringsCount', parseInt(count), vscode.ConfigurationTarget.Global);
    }
}

async function maxCacheSizeCommand(terragruntNav) {
    let maxCacheSize = terragruntNav.maxCacheSize;
    let count = await vscode.window.showInputBox({
        prompt: 'Enter the maximum number of cache directories to keep',
        value: maxCacheSize.toString(),
    });

    if (count !== undefined) {
        let config = vscode.workspace.getConfiguration('terragrunt-navigator', null);
        await config.update('maxCacheSize', parseInt(count), vscode.ConfigurationTarget.Global);
    }
}

async function replacementStringsCommand(terragruntNav) {
    let updated = false;
    let replacementStrings = terragruntNav.replacementStrings;
    let maxIterations = Math.min(terragruntNav.quickReplaceStringsCount, replacementStrings.length);

    for (let i = 0; i < maxIterations; i++) {
        let replacement = replacementStrings[i];

        let find = await vscode.window.showInputBox({
            prompt: 'Enter the string to find for replacement',
            value: replacement.find,
        });
        let replace = await vscode.window.showInputBox({
            prompt: 'Enter the replacement string',
            value: replacement.replace,
        });

        if (find !== undefined && replace !== undefined) {
            replacement.find = find;
            replacement.replace = replace;
            updated = true;
        }
    }

    if (updated) {
        let config = vscode.workspace.getConfiguration('terragrunt-navigator', null);
        await config.update('replacementStrings', replacementStrings, vscode.ConfigurationTarget.Global);
    }
}

function getFeatureTogglesConfig() {
    let config = vscode.workspace.getConfiguration('terragrunt-navigator');
    let toggles = config.get('featureToggles') || {
        ReplaceStrings: undefined,
        AddTerragruntCacheToWorkspace: undefined,
    };

    let featureToggles = {};
    featureToggles['ReplaceStrings'] = toggles['ReplaceStrings'];
    featureToggles['AddTerragruntCacheToWorkspace'] = toggles['AddTerragruntCacheToWorkspace'];

    return featureToggles;
}

async function featureTogglesCommand(terragruntNav) {
    let featureToggles = getFeatureTogglesConfig();
    let featureTogglesMap = Object.entries(featureToggles).map(([featureName, isEnabled]) => ({
        label: `${isEnabled ? '✅' : '❌'} ${featureName}`,
        featureName,
        isEnabled,
    }));

    const selected = await vscode.window.showQuickPick(featureTogglesMap, {
        placeHolder: 'Select a feature to toggle',
    });

    if (selected) {
        featureToggles[selected.featureName] = !selected.isEnabled;
        let config = vscode.workspace.getConfiguration('terragrunt-navigator');
        await config.update('featureToggles', featureToggles, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
            `Feature "${selected.featureName}" is now ${featureToggles[selected.featureName] ? 'enabled' : 'disabled'}.`,
        );
    }
}

async function saveInputJsonCommand(terragruntNav) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    if (terragruntNav.tfInfo?.configs.inputs === undefined) {
        vscode.window.showInformationMessage('No inputs found in the current file');
        return;
    }

    let inputJson = path.join(path.dirname(editor.document.uri.fsPath), 'input.json');
    fs.writeFileSync(inputJson, JSON.stringify({ inputs: terragruntNav.tfInfo.configs.inputs }, null, 2));
    vscode.window.showInformationMessage('Saved inputs to ' + inputJson);
}

function activate(context) {
    console.log('Terragrunt Navigator is now active!');
    let terragruntNav = new TerragruntNav(context);

    let filePatterns = ['**/*.hcl', '**/*.tf'];
    for (let pattern of filePatterns) {
        context.subscriptions.push(
            vscode.languages.registerDocumentLinkProvider({ scheme: 'file', pattern: pattern }, terragruntNav),
        );
        context.subscriptions.push(
            vscode.languages.registerDefinitionProvider({ scheme: 'file', pattern: pattern }, terragruntNav),
        );
    }

    let commandFunctionMap = {
        quickReplaceStringsCountCommand: quickReplaceStringsCountCommand,
        maxCacheSizeCommand: maxCacheSizeCommand,
        replacementStringsCommand: replacementStringsCommand,
        featureTogglesCommand: featureTogglesCommand,
        saveInputJsonCommand: saveInputJsonCommand,
    };
    for (let command in commandFunctionMap) {
        context.subscriptions.push(
            vscode.commands.registerCommand(
                `terragrunt-navigator.${command}`,
                commandFunctionMap[command].bind(null, terragruntNav),
            ),
        );
    }

    vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('terragrunt-navigator.quickReplaceStringsCount')) {
            terragruntNav.quickReplaceStringsCount = vscode.workspace
                .getConfiguration('terragrunt-navigator')
                .get('quickReplaceStringsCount');
        }
        if (event.affectsConfiguration('terragrunt-navigator.maxCacheSize')) {
            terragruntNav.maxCacheSize = vscode.workspace.getConfiguration('terragrunt-navigator').get('maxCacheSize');
        }
        if (event.affectsConfiguration('terragrunt-navigator.replacementStrings')) {
            if (vscode.window.activeTextEditor) {
                terragruntNav.provideDocumentLinks(vscode.window.activeTextEditor.document, null);
            }
        }
        // Update the feature toggles when the settings are changed
        if (event.affectsConfiguration('terragrunt-navigator.featureToggles')) {
            let featureToggles = getFeatureTogglesConfig();
            terragruntNav.replaceStrings = featureToggles['ReplaceStrings'];
            terragruntNav.addTerragruntCacheToWorkspace = featureToggles['AddTerragruntCacheToWorkspace'];
        }
    });

    // Reset the cache when the document is changed
    vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.activeTextEditor;
        if (terragruntNav.lastModulePath && editor?.document) {
            const dirPath = path.dirname(editor.document.uri.fsPath);
            if (terragruntNav.lastModulePath === dirPath) {
                terragruntNav.tfCache[dirPath] = {};
                terragruntNav.lastModulePath = null;
            }
        }
    });
}

exports.activate = activate;

module.exports = {
    activate,
};
