import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const allowedTypes = ['feat', 'fix', 'refactoring', 'style', 'devops', 'docs', 'test'] as const;
const apiKeyStorageKey = 'smartCommit.openaiApiKey';
const maxCommitMessageLength = 80;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('smartCommit.settingsView', {
      async resolveWebviewView(view) {
        view.webview.options = { enableScripts: true };
        view.webview.html = settingsHtml(view.webview, Boolean(await context.secrets.get(apiKeyStorageKey)));
        view.webview.onDidReceiveMessage(async message => {
          if (message.command === 'generate') {
            await vscode.commands.executeCommand('smartCommit.generate');
            view.webview.postMessage({ command: 'generated' });
          } else if (message.command === 'checkMain') {
            try {
              const readiness = await assertMainIsCurrent(folderPath());
              view.webview.postMessage({ command: 'tagReadiness', ready: true, remote: readiness.remote, message: `main актуальна и синхронизирована с ${readiness.remote}. Можно создавать тег.` });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              view.webview.postMessage({ command: 'tagReadiness', ready: false, message: detail });
            }
          } else if (message.command === 'prepareTag') {
            try {
              const cwd = folderPath();
              await assertMainIsCurrent(cwd);
              const apiKey = await context.secrets.get(apiKeyStorageKey);
              const description = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Готовим описание тега…', cancellable: false },
                async () => {
                  const log = await commitsSincePreviousTag(cwd, 'main');
                  return generateTagDescription(log, apiKey);
                }
              );
              view.webview.postMessage({ command: 'tagDescriptionReady', description });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              if (error instanceof TagReadinessError) {
                view.webview.postMessage({ command: 'tagReadiness', ready: false, message: detail });
              } else {
                view.webview.postMessage({ command: 'tagError', message: detail });
              }
            }
          } else if (message.command === 'createTag') {
            try {
              const cwd = folderPath();
              const readiness = await assertMainIsCurrent(cwd);
              const name = String(message.name ?? '').trim();
              const description = String(message.description ?? '').trim();
              if (!name) throw new Error('Укажите имя тега.');
              if (!description) throw new Error('Добавьте описание тега.');
              await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Создаём аннотированный тег ${name} и отправляем его…`, cancellable: false },
                async () => {
                  await execFileAsync('git', ['check-ref-format', `refs/tags/${name}`], { cwd });
                  await execFileAsync('git', ['tag', '-a', name, 'main', '-m', description], { cwd });
                  try {
                    await execFileAsync('git', ['push', '--porcelain', readiness.remote, `refs/tags/${name}`], { cwd, maxBuffer: 2 * 1024 * 1024 });
                  } catch (error) {
                    throw new TagPushError(name, readiness.remote, error instanceof Error ? error.message : String(error));
                  }
                }
              );
              view.webview.postMessage({ command: 'tagCreated', name, remote: readiness.remote });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              if (error instanceof TagPushError) {
                view.webview.postMessage({ command: 'tagPushError', name: error.tagName, remote: error.remote, message: error.message });
              } else if (error instanceof TagReadinessError) {
                view.webview.postMessage({ command: 'tagReadiness', ready: false, message: detail });
              } else {
                view.webview.postMessage({ command: 'tagError', message: detail });
              }
            }
          } else if (message.command === 'openSettings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'smartCommit');
          } else if (message.command === 'save') {
            try {
              const apiUrl = String(message.apiUrl ?? '').trim();
              const model = String(message.model ?? '').trim();
              if (!apiUrl || !model) throw new Error('Заполните адрес API и название модели.');
              const configuration = vscode.workspace.getConfiguration('smartCommit');
              await configuration.update('apiUrl', apiUrl, vscode.ConfigurationTarget.Global);
              await configuration.update('model', model, vscode.ConfigurationTarget.Global);
              const savedApiUrl = configuration.inspect<string>('apiUrl')?.globalValue;
              const savedModel = configuration.inspect<string>('model')?.globalValue;
              const apiUrlStored = savedApiUrl === apiUrl || (!savedApiUrl && apiUrl === 'https://api.openai.com/v1');
              const modelStored = savedModel === model || (!savedModel && model === 'gpt-4o-mini');
              if (!apiUrlStored || !modelStored) {
                throw new Error('VS Code не подтвердил запись настроек. Проверьте активный профиль и права доступа к пользовательским настройкам.');
              }
              const token = String(message.apiKey ?? '').trim();
              if (token) await context.secrets.store(apiKeyStorageKey, token);
              else if (message.removeApiKey) await context.secrets.delete(apiKeyStorageKey);
              view.webview.postMessage({ command: 'saved', hasApiKey: token.length > 0 || (!message.removeApiKey && Boolean(await context.secrets.get(apiKeyStorageKey))) });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              view.webview.postMessage({ command: 'saveError', message: detail });
            }
          }
        }, undefined, context.subscriptions);
      }
    }),
    vscode.commands.registerCommand('smartCommit.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'smartCommit')),
    vscode.commands.registerCommand('smartCommit.setApiKey', async () => {
      const entered = await vscode.window.showInputBox({
        title: 'Set API token',
        prompt: 'Enter a key to save, or leave empty to remove the saved key.',
        password: true,
        ignoreFocusOut: true
      });
      if (entered === undefined) return;
      if (!entered.trim()) {
        await context.secrets.delete(apiKeyStorageKey);
        void vscode.window.showInformationMessage('Saved API token removed. Requests will be sent without a token.');
        return;
      }
      await context.secrets.store(apiKeyStorageKey, entered.trim());
      void vscode.window.showInformationMessage('API token updated.');
    }),
    vscode.commands.registerCommand('smartCommit.generate', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showErrorMessage('Open a Git repository to generate a commit message.');
        return;
      }

      try {
        const [branchResult, diffResult] = await Promise.all([
          execFileAsync('git', ['branch', '--show-current'], { cwd: folder.uri.fsPath, maxBuffer: 1024 * 1024 }),
          execFileAsync('git', ['diff', '--cached', '--no-ext-diff', '--unified=2'], { cwd: folder.uri.fsPath, maxBuffer: 8 * 1024 * 1024 })
        ]);
        const branch = branchResult.stdout.trim();
        const diff = diffResult.stdout.trim();
        if (!diff) {
          void vscode.window.showWarningMessage('There are no staged changes. Stage files before generating a commit message.');
          return;
        }

        const prefix = branchPrefix(branch);
        const apiKey = await context.secrets.get(apiKeyStorageKey);
        const generated = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Generating commit message…', cancellable: false },
          () => generateMessage(diff, prefix, apiKey)
        );
        const gitExtension = vscode.extensions.getExtension<{ getAPI(version: number): { repositories: Array<{ rootUri: vscode.Uri; inputBox: { value: string } }> } }>('vscode.git');
        const gitApi = gitExtension ? await gitExtension.activate() : undefined;
        const repository = gitApi?.getAPI(1).repositories.find(repo => folder.uri.fsPath === repo.rootUri.fsPath || folder.uri.fsPath.startsWith(`${repo.rootUri.fsPath}/`));
        if (!repository) throw new Error('Could not access the Git commit message box.');
        repository.inputBox.value = generated;
        void vscode.window.showInformationMessage(`Commit message generated: ${generated}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Could not generate commit message: ${message}`);
      }
    })
  );
}

function settingsHtml(webview: vscode.Webview, hasApiKey: boolean): string {
  const configuration = vscode.workspace.getConfiguration('smartCommit');
  const apiUrl = escapeHtml(configuration.get<string>('apiUrl', 'https://api.openai.com/v1'));
  const model = escapeHtml(configuration.get<string>('model', 'gpt-4o-mini'));
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px 14px 20px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 12px; }
    .brand { display: flex; align-items: center; gap: 10px; margin: 0 0 16px; }
    .brand-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .brand-icon svg { width: 18px; height: 18px; }
    h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .1px; }
    .subtitle { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4; }
    .hero { padding: 13px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 10px; background: var(--vscode-editor-background); }
    .hero-title { margin: 0 0 5px; font-size: 12px; font-weight: 600; }
    .hero-copy { margin: 0 0 12px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.5; }
    button { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; min-height: 30px; padding: 6px 10px; border: 0; border-radius: 5px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; font-weight: 600; cursor: pointer; transition: background .12s ease, transform .12s ease; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:active { transform: translateY(1px); }
    button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    button:disabled { opacity: .65; cursor: wait; }
    .button-icon { width: 14px; height: 14px; }
    .section-heading { display: flex; align-items: center; justify-content: space-between; margin: 20px 1px 10px; }
    h2 { margin: 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .6px; }
    .section-note { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .field { margin-top: 11px; }
    label { display: block; margin: 0 0 5px; font-size: 11px; font-weight: 500; }
    input { display: block; width: 100%; min-height: 29px; padding: 5px 8px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
    input::placeholder { color: var(--vscode-input-placeholderForeground); }
    .token-state { display: flex; align-items: center; gap: 6px; margin: 7px 1px 0; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .dot.saved { background: var(--vscode-testing-iconPassed, #73c991); }
    .hint { margin: 6px 1px 0; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.45; }
    .secondary { margin-top: 8px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font-weight: 500; }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #status { min-height: 15px; margin: 10px 1px 0; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.4; }
    .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; padding: 3px; margin: 0 0 14px; border-radius: 6px; background: var(--vscode-editor-background); }
    .tab { min-height: 26px; padding: 4px 8px; border-radius: 4px; color: var(--vscode-descriptionForeground); background: transparent; font-weight: 500; }
    .tab:hover { background: var(--vscode-toolbar-hoverBackground); }
    .tab.active { color: var(--vscode-foreground); background: var(--vscode-sideBarSectionHeaderBackground, var(--vscode-input-background)); }
    [hidden] { display: none !important; }
    .tag-card { margin-top: 14px; padding: 13px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 10px; }
    .tag-card h2 { margin: 0 0 5px; font-size: 12px; text-transform: none; letter-spacing: 0; }
    .tag-card .hero-copy { margin-bottom: 10px; }
    .tag-description-label { margin-top: 12px; }
    .tag-lock { margin: 9px 1px; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.5; }
    textarea { display: block; width: 100%; min-height: 112px; margin-top: 10px; padding: 8px; resize: vertical; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; line-height: 1.5; }
    textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  </style>
</head>
<body>
  <header class="brand">
    <div class="brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h14v15H5zM8.5 9h7M8.5 12.5h7M8.5 16h4"/><path d="m18.5 2 .7 1.8L21 4.5l-1.8.7-.7 1.8L17.8 5l-1.8-.5 1.8-.7z" fill="currentColor" stroke="none"/></svg></div>
    <div><h1>Smart Commit</h1><div class="subtitle">Умные сообщения коммитов</div></div>
  </header>
  <nav class="tabs" aria-label="Разделы">
    <button class="tab" data-tab="settings" aria-selected="false">Настройки</button>
    <button class="tab active" data-tab="work" aria-selected="true">Работа</button>
  </nav>
  <main id="workTab">
  <section class="hero">
    <p class="hero-title">Готовы к коммиту?</p>
    <p class="hero-copy">Создайте короткое сообщение по подготовленным изменениям.</p>
    <button id="generate"><svg class="button-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.2 9.5 6.5 14.8 8l-5.3 1.5L8 14.8l-1.5-5.3L1.2 8l5.3-1.5L8 1.2Z"/></svg>Сгенерировать сообщение</button>
  </section>
  <section class="tag-card">
    <h2>Создать тег релиза</h2>
    <p class="hero-copy">Тег и описание будут созданы для актуальной ветки main. Влитые ветки учитываются.</p>
    <p id="tagLock" class="tag-lock">Сначала проверьте, что вы на main и локальная ветка синхронизирована с remote.</p>
    <button id="checkMain" class="secondary">Проверить main</button>
    <div id="tagControls" hidden>
    <div class="field"><label for="tagName">Имя тега</label><input id="tagName" type="text" placeholder="Например, v1.2.0"></div>
    <button id="prepareTag" class="secondary">Составить описание</button>
    <label class="tag-description-label" for="tagDescription">Описание тега</label>
    <textarea id="tagDescription" placeholder="Здесь появится описание изменений. Его можно отредактировать перед созданием тега."></textarea>
    <button id="createTag" disabled>Создать аннотированный тег</button>
    </div>
  </section>
  </main>
  <main id="settingsTab" hidden>
  <div class="section-heading"><h2>Настройки API</h2><span class="section-note">OpenAI-совместимый</span></div>
  <div class="field"><label for="apiUrl">Адрес API</label>
  <input id="apiUrl" type="url" value="${apiUrl}">
  </div>
  <div class="field"><label for="model">Модель</label>
  <input id="model" type="text" value="${model}">
  </div>
  <div class="field"><label for="apiKey">API-токен</label>
  <input id="apiKey" type="password" placeholder="${hasApiKey ? 'Введите новый токен для замены' : 'Вставьте токен, если требуется'}" autocomplete="new-password">
  <div class="token-state"><span class="dot ${hasApiKey ? 'saved' : ''}"></span>${hasApiKey ? 'Токен сохранён' : 'Токен не задан'}</div>
  <p class="hint">Токен хранится в защищённом хранилище VS Code.</p></div>
  <button id="save" class="secondary">Сохранить настройки</button>
  <button id="removeKey" class="secondary">Удалить сохранённый токен</button>
  <button id="settings" class="secondary">Все настройки VS Code</button>
  </main>
  <p id="status" role="status"></p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const status = document.getElementById('status');
    const generateButton = document.getElementById('generate');
    generateButton.addEventListener('click', () => { generateButton.disabled = true; status.textContent = 'Готовим сообщение…'; vscode.postMessage({ command: 'generate' }); });
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(item => { item.classList.remove('active'); item.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active'); tab.setAttribute('aria-selected', 'true');
      document.getElementById('workTab').hidden = tab.dataset.tab !== 'work';
      document.getElementById('settingsTab').hidden = tab.dataset.tab !== 'settings';
    }));
    const tagDescription = document.getElementById('tagDescription');
    const tagName = document.getElementById('tagName');
    const createTagButton = document.getElementById('createTag');
    const updateCreateTag = () => { createTagButton.disabled = !tagName.value.trim() || !tagDescription.value.trim(); };
    document.getElementById('checkMain').addEventListener('click', event => {
      event.currentTarget.disabled = true; document.getElementById('tagLock').textContent = 'Проверяем main и обновления с remote…'; vscode.postMessage({ command: 'checkMain' });
    });
    tagName.addEventListener('input', updateCreateTag);
    tagDescription.addEventListener('input', updateCreateTag);
    document.getElementById('prepareTag').addEventListener('click', event => {
      event.currentTarget.disabled = true; status.textContent = 'Анализируем историю коммитов…'; vscode.postMessage({ command: 'prepareTag' });
    });
    createTagButton.addEventListener('click', () => { createTagButton.disabled = true; status.textContent = 'Создаём аннотированный тег и отправляем его в remote…'; vscode.postMessage({ command: 'createTag', name: tagName.value, description: tagDescription.value }); });
    document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ command: 'openSettings' }));
    document.getElementById('save').addEventListener('click', () => { status.textContent = 'Сохраняем в пользовательские настройки…'; vscode.postMessage({ command: 'save', apiUrl: document.getElementById('apiUrl').value, model: document.getElementById('model').value, apiKey: document.getElementById('apiKey').value }); });
    document.getElementById('removeKey').addEventListener('click', () => { status.textContent = 'Сохраняем настройки…'; vscode.postMessage({ command: 'save', apiUrl: document.getElementById('apiUrl').value, model: document.getElementById('model').value, removeApiKey: true }); });
    window.addEventListener('message', event => {
      if (event.data.command === 'saved') {
        document.getElementById('apiKey').value = '';
        document.querySelector('.token-state').innerHTML = '<span class="dot ' + (event.data.hasApiKey ? 'saved' : '') + '"></span>' + (event.data.hasApiKey ? 'Токен сохранён' : 'Токен не задан');
        status.textContent = 'Настройки сохранены.';
      }
      if (event.data.command === 'saveError') { status.textContent = 'Ошибка сохранения: ' + event.data.message; }
      if (event.data.command === 'generated') { generateButton.disabled = false; status.textContent = 'Готово. Проверьте сообщение в Source Control.'; }
      if (event.data.command === 'tagReadiness') {
        document.getElementById('checkMain').disabled = false;
        document.getElementById('tagControls').hidden = !event.data.ready;
        document.getElementById('tagLock').textContent = event.data.message;
        if (!event.data.ready) status.textContent = 'Создание тега недоступно. Перейдите на main и обновите код.';
      }
      if (event.data.command === 'tagDescriptionReady') { document.getElementById('prepareTag').disabled = false; tagDescription.value = event.data.description; updateCreateTag(); status.textContent = 'Описание готово. Проверьте его и создайте тег.'; }
      if (event.data.command === 'tagCreated') { status.textContent = 'Аннотированный тег ' + event.data.name + ' создан для main и отправлен в ' + event.data.remote + '.'; createTagButton.disabled = true; }
      if (event.data.command === 'tagPushError') { status.textContent = 'Тег ' + event.data.name + ' создан локально, но не отправлен: ' + event.data.message + '. Повторите: git push ' + event.data.remote + ' refs/tags/' + event.data.name; }
      if (event.data.command === 'tagError') { document.getElementById('prepareTag').disabled = false; updateCreateTag(); status.textContent = event.data.message; }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

async function commitsSincePreviousTag(cwd: string): Promise<string> {
  let previousTag: string | undefined;
  try {
    const result = await execFileAsync('git', ['describe', '--tags', '--abbrev=0', 'HEAD'], { cwd, maxBuffer: 1024 * 1024 });
    previousTag = result.stdout.trim();
  } catch {
    // A repository without tags uses its available commit history as the first release range.
  }

  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
  const result = await execFileAsync('git', ['log', '--max-count=500', '--decorate=short', '--format=%h%x09%d%x09%s%n%b%n---', range], { cwd, maxBuffer: 8 * 1024 * 1024 });
  const log = result.stdout.trim();
  if (!log) throw new Error('После предыдущего тега нет коммитов для описания.');
  return `Диапазон: ${previousTag ? `${previousTag}..HEAD` : 'вся история до HEAD'}\n\n${log.slice(0, 60_000)}`;
}

async function generateTagDescription(commitLog: string, apiKey: string | undefined): Promise<string> {
  const configuration = vscode.workspace.getConfiguration('smartCommit');
  const apiUrl = configuration.get<string>('apiUrl', 'https://api.openai.com/v1').trim().replace(/\/$/, '');
  const model = configuration.get<string>('model', 'gpt-4o-mini').trim();
  if (!model) throw new Error('Укажите модель в настройках Smart Commit.');

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'По истории коммитов составь список выполненных задач на русском языке. В истории есть коммиты из всех веток, влитых в текущую ветку за период. Найди ID задач в названиях веток, сообщениях merge-коммитов, заголовках и телах коммитов. Сгруппируй изменения по ID задачи и опиши результат каждой задачи одной очень короткой строкой не длиннее 150 символов, включая ID. Формат каждой строки строго: M-1: Сделано ... Верни только строки задач без заголовка, вступления, Markdown-маркеров и заключения. Не придумывай ID и содержание; если ID не найден, используй «Без задачи: ...».'
        },
        { role: 'user', content: `История коммитов текущей ветки:\n${commitLog}` }
      ]
    })
  });

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(payload.error?.message ?? `API вернул HTTP ${response.status}`);
  const responseText = payload.choices?.[0]?.message?.content?.trim();
  if (!responseText) throw new Error('API вернул пустое описание.');
  return normalizeTagDescription(responseText);
}

function normalizeTagDescription(responseText: string): string {
  const tasks = new Map<string, string>();
  for (const sourceLine of responseText.split(/\r?\n/)) {
    const line = sourceLine.replace(/^\s*(?:[-*•]\s*)?/, '').trim();
    const match = line.match(/^((?:[\p{L}][\p{L}\d]*(?:-[\p{L}\d]+)+)|Без задачи)\s*:\s*(.+)$/iu);
    if (!match) continue;
    const id = match[1].toLocaleLowerCase('ru-RU') === 'без задачи' ? 'Без задачи' : match[1].toUpperCase();
    if (tasks.has(id)) continue;
    const maxSummaryLength = 150 - id.length - 2;
    let summary = match[2].trim();
    if (summary.length > maxSummaryLength) {
      const bounded = summary.slice(0, maxSummaryLength + 1).trimEnd();
      const lastSpace = bounded.lastIndexOf(' ');
      summary = lastSpace > 0 ? bounded.slice(0, lastSpace) : bounded.slice(0, maxSummaryLength);
    }
    tasks.set(id, summary);
  }
  if (!tasks.size) throw new Error('Не удалось выделить задачи и их ID из ответа модели. Проверьте историю коммитов.');
  return [...tasks].map(([id, summary]) => `${id}: ${summary}`).join('\n');
}

function branchPrefix(branch: string): string {
  const match = branch.match(/^([^-]+)-([^-]+)(?:-|$)/);
  if (!match) {
    throw new Error(`Branch "${branch}" must start with a ticket like dwh-123-...`);
  }
  return `#${match[1].toUpperCase()}-${match[2]}`;
}

async function generateMessage(diff: string, prefix: string, apiKey: string | undefined): Promise<string> {
  const configuration = vscode.workspace.getConfiguration('smartCommit');
  const apiUrl = configuration.get<string>('apiUrl', 'https://api.openai.com/v1').trim().replace(/\/$/, '');
  const model = configuration.get<string>('model', 'gpt-4o-mini').trim();
  if (!model) throw new Error('Set a model name in Smart Commit Message settings.');
  // Keep requests bounded while preserving the beginning of each staged patch.
  const boundedDiff = diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n[diff truncated]` : diff;
  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `Write one concise commit subject of at most ${maxCommitMessageLength} characters, in English, in this exact format: ${prefix} <type>: <imperative summary>. Choose exactly one type: ${allowedTypes.join(', ')}. feat is a user-facing feature; fix corrects a bug; refactoring restructures code without changing behavior; style is lint/format-only cleanup; devops is deployment/infrastructure work; docs is documentation; test is test-only work. Infer the most fitting type and summary from the staged diff. Return only the subject line, no quotes, markdown, or explanation.`
        },
        { role: 'user', content: `Staged diff:\n${boundedDiff}` }
      ]
    })
  });

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `API returned HTTP ${response.status}`);
  }
  const line = payload.choices?.[0]?.message?.content?.trim().split(/\r?\n/, 1)[0]?.replace(/^['"`]+|['"`]+$/g, '');
  if (!line) {
    throw new Error('The API returned an empty commit message.');
  }
  const expectedPrefix = `${prefix} `;
  const normalized = line.toLowerCase().startsWith(expectedPrefix.toLowerCase()) ? line : `${expectedPrefix}${line}`;
  const typeMatch = normalized.match(new RegExp(`^${escapeRegExp(prefix)} (${allowedTypes.join('|')}):\\s+.+$`, 'i'));
  if (!typeMatch) {
    throw new Error(`The API returned an invalid message: ${normalized}`);
  }
  return limitCommitMessage(normalized);
}

function limitCommitMessage(message: string): string {
  if (message.length <= maxCommitMessageLength) return message;

  const summaryStart = message.indexOf(': ') + 2;
  const availableSummaryLength = maxCommitMessageLength - summaryStart;
  if (availableSummaryLength <= 0) return message.slice(0, maxCommitMessageLength);

  const summary = message.slice(summaryStart, summaryStart + availableSummaryLength + 1).trimEnd();
  const lastSpace = summary.lastIndexOf(' ');
  const boundedSummary = lastSpace > 0 ? summary.slice(0, lastSpace) : summary.slice(0, availableSummaryLength);
  return `${message.slice(0, summaryStart)}${boundedSummary}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deactivate(): void {}
