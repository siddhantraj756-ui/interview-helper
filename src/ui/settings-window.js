document.addEventListener('DOMContentLoaded', () => {    
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const speechProviderSelect = document.getElementById('speechProvider');
    const azureKeyInput = document.getElementById('azureKey');
    const azureRegionInput = document.getElementById('azureRegion');
    const whisperCommandInput = document.getElementById('whisperCommand');
    const whisperModelInput = document.getElementById('whisperModel');
    const whisperLanguageInput = document.getElementById('whisperLanguage');
    const whisperDeviceSelect = document.getElementById('whisperDevice');
    const whisperCaptureModeSelect = document.getElementById('whisperCaptureMode');
    const whisperResponseTargetSelect = document.getElementById('whisperResponseTarget');
    const whisperSegmentMsInput = document.getElementById('whisperSegmentMs');
    const geminiKeyInput = document.getElementById('geminiKey');
    const openaiKeyInput = document.getElementById('openaiKey');
    const geminiPaidKeyInput = document.getElementById('geminiPaidKey');
    const geminiFreeKeyInput = document.getElementById('geminiFreeKey');
    const openaiModelInput = document.getElementById('openaiModel');
    const candidateResumeInput = document.getElementById('candidateResume');
    const jobDescriptionInput = document.getElementById('jobDescription');
    const windowGapInput = document.getElementById('windowGap');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const iconGrid = document.getElementById('iconGrid');
    const personalDetailsInput = document.getElementById('personalDetails');

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                
                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }
                
                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);
                
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        if (settings.speechProvider && speechProviderSelect) speechProviderSelect.value = settings.speechProvider;
        // Always set the input value, even if empty, so the user sees what's
        // currently configured (including env-derived defaults). Previously
        // empty strings were skipped which left stale UI values.
        if (azureKeyInput) azureKeyInput.value = settings.azureKey || '';
        if (azureRegionInput) azureRegionInput.value = settings.azureRegion || '';
        if (whisperCommandInput) whisperCommandInput.value = settings.whisperCommand || '';
        if (whisperModelInput) whisperModelInput.value = settings.whisperModel || '';
        if (whisperLanguageInput) whisperLanguageInput.value = settings.whisperLanguage || '';
        if (whisperDeviceSelect) whisperDeviceSelect.value = settings.whisperDevice || 'auto';
        if (whisperCaptureModeSelect) whisperCaptureModeSelect.value = settings.whisperCaptureMode || 'vad';
        if (whisperResponseTargetSelect) whisperResponseTargetSelect.value = settings.whisperResponseTarget || 'both';
        if (whisperSegmentMsInput) whisperSegmentMsInput.value = settings.whisperSegmentMs || '';
        if (geminiKeyInput) geminiKeyInput.value = '';
        if (openaiKeyInput) openaiKeyInput.value = '';
        if (geminiPaidKeyInput) geminiPaidKeyInput.value = '';
        if (geminiFreeKeyInput) geminiFreeKeyInput.value = '';
        if (openaiModelInput) openaiModelInput.value = settings.openaiModel || 'gpt-6.2-sol';
        if (windowGapInput) windowGapInput.value = settings.windowGap || '';

        // Set C++ as default if no coding language is specified
        if (codingLanguageSelect) {
            codingLanguageSelect.value = settings.codingLanguage || 'cpp';
        }

        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;
        if (personalDetailsInput) personalDetailsInput.value = settings.personalDetails || '';
        if (candidateResumeInput) candidateResumeInput.value = settings.candidateResume || '';
        if (jobDescriptionInput) jobDescriptionInput.value = settings.jobDescription || '';
        setConfiguredStatus('openaiStatus', !!settings.openaiConfigured);
        setConfiguredStatus('geminiPaidStatus', !!settings.geminiPaidConfigured);
        setConfiguredStatus('geminiFreeStatus', !!settings.geminiFreeConfigured);
        const providerStatus = document.getElementById('providerSummary');
        if (providerStatus) providerStatus.textContent = `Preferred provider: ${settings.providerStatus?.preferredProvider || 'Not configured'}. Fallback order: OpenAI → Paid Gemini → Free Gemini.`;

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }

        updateSpeechFieldStates();
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            requestCurrentSettings();
        });

    // Listen for coding language changes from other windows via helper
    window.electronAPI.onCodingLanguageChanged((event, data) => {
            if (data && data.language && codingLanguageSelect) {
                codingLanguageSelect.value = data.language;
                console.log('Language updated from overlay window:', data.language);
            }
    });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (speechProviderSelect) settings.speechProvider = speechProviderSelect.value;
        if (azureKeyInput) settings.azureKey = azureKeyInput.value;
        if (azureRegionInput) settings.azureRegion = azureRegionInput.value;
        if (whisperCommandInput) settings.whisperCommand = whisperCommandInput.value;
        if (whisperModelInput) settings.whisperModel = whisperModelInput.value;
        if (whisperLanguageInput) settings.whisperLanguage = whisperLanguageInput.value;
        if (whisperDeviceSelect) settings.whisperDevice = whisperDeviceSelect.value;
        if (whisperCaptureModeSelect) settings.whisperCaptureMode = whisperCaptureModeSelect.value;
        if (whisperResponseTargetSelect) settings.whisperResponseTarget = whisperResponseTargetSelect.value;
        if (whisperSegmentMsInput) settings.whisperSegmentMs = whisperSegmentMsInput.value;
        if (openaiModelInput) settings.openaiModel = openaiModelInput.value;
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;
        if (personalDetailsInput) settings.personalDetails = personalDetailsInput.value;
        if (candidateResumeInput) settings.candidateResume = candidateResumeInput.value;
        if (jobDescriptionInput) settings.jobDescription = jobDescriptionInput.value;
        
        window.api.send('save-settings', settings);
    };

    function setConfiguredStatus(id, configured, detail = '') {
        const element = document.getElementById(id);
        if (element) element.textContent = detail || (configured ? 'Configured' : 'Not configured');
    }

    const providerInputs = { openai: openaiKeyInput, geminiPaid: geminiPaidKeyInput, geminiFree: geminiFreeKeyInput };
    const providerStatusIds = { openai: 'openaiStatus', geminiPaid: 'geminiPaidStatus', geminiFree: 'geminiFreeStatus' };
    for (const [provider, input] of Object.entries(providerInputs)) {
        if (!input) continue;
        const title = provider === 'openai' ? 'OpenAI' : provider === 'geminiPaid' ? 'Paid Gemini' : 'Free Gemini';
        document.getElementById(`save${provider === 'openai' ? 'OpenAI' : provider === 'geminiPaid' ? 'GeminiPaid' : 'GeminiFree'}`)
            ?.addEventListener('click', async () => {
                if (!input.value.trim()) { setConfiguredStatus(providerStatusIds[provider], false, 'Enter a key to save or update.'); return; }
                try {
                    await window.electronAPI.saveProviderCredentials({ [provider]: input.value });
                    input.value = '';
                    const statuses = await window.electronAPI.getSettings();
                    setConfiguredStatus(providerStatusIds[provider], !!statuses[`${provider}Configured`], `${title} key saved securely`);
                    if (provider === 'openai') setConfiguredStatus('openaiStatus', true, `${title} key saved securely`);
                    const summary = document.getElementById('providerSummary');
                    if (summary) summary.textContent = `Preferred provider: ${statuses.providerStatus?.preferredProvider || title}. Fallback order: OpenAI → Paid Gemini → Free Gemini.`;
                } catch (error) { setConfiguredStatus(providerStatusIds[provider], false, error.message || 'Could not save key securely.'); }
            });
        document.getElementById(`remove${provider === 'openai' ? 'OpenAI' : provider === 'geminiPaid' ? 'GeminiPaid' : 'GeminiFree'}`)
            ?.addEventListener('click', async () => {
                try {
                    await window.electronAPI.saveProviderCredentials({ [provider]: null });
                    const statuses = await window.electronAPI.getSettings();
                    setConfiguredStatus(providerStatusIds[provider], !!statuses[`${provider}Configured`]);
                    const summary = document.getElementById('providerSummary');
                    if (summary) summary.textContent = `Preferred provider: ${statuses.providerStatus?.preferredProvider || 'Not configured'}. Fallback order: OpenAI → Paid Gemini → Free Gemini.`;
                } catch (error) { setConfiguredStatus(providerStatusIds[provider], true, error.message || 'Could not remove key.'); }
            });
        const testId = provider === 'openai' ? 'testOpenAI' : provider === 'geminiPaid' ? 'testGeminiPaid' : 'testGeminiFree';
        document.getElementById(testId)?.addEventListener('click', async () => {
            setConfiguredStatus(providerStatusIds[provider], true, 'Testing connection…');
            try {
                const result = provider === 'openai'
                    ? await window.electronAPI.testOpenAIConnection()
                    : await window.electronAPI.testGeminiKey(provider === 'geminiFree' ? 'free' : 'paid');
                setConfiguredStatus(providerStatusIds[provider], result.success, result.success
                    ? `Connected · ${result.model || title}`
                    : `${result.errorType || 'Error'} · ${result.error || 'Connection failed'}`);
            } catch (error) { setConfiguredStatus(providerStatusIds[provider], false, error.message || 'Connection test failed.'); }
        });
    }
    document.querySelectorAll('.key-toggle').forEach(button => button.addEventListener('click', () => {
        const input = document.getElementById(button.dataset.target);
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
        button.textContent = input.type === 'password' ? 'Show' : 'Hide';
    }));

    const updateSpeechFieldStates = () => {
        const provider = speechProviderSelect ? speechProviderSelect.value : 'azure';

        // Show/hide provider-specific field groups instead of just disabling
        // them. This keeps the settings UI clean — only the relevant fields
        // for the selected provider are visible.
        const azureGroup = document.getElementById('azureFields');
        const whisperGroup = document.getElementById('whisperFields');
        const azureNote = document.getElementById('azureFieldsNote');

        if (azureGroup) {
            azureGroup.style.display = provider === 'azure' ? '' : 'none';
        }
        if (whisperGroup) {
            whisperGroup.style.display = provider === 'whisper' ? '' : 'none';
        }
        if (azureNote) {
            azureNote.style.display = provider === 'azure' ? '' : 'none';
        }

        // Also toggle disabled attribute for any leftover direct field refs
        [azureKeyInput, azureRegionInput].forEach(input => {
            if (input) input.disabled = provider !== 'azure';
        });
        [whisperCommandInput, whisperModelInput, whisperLanguageInput, whisperDeviceSelect,
            whisperCaptureModeSelect, whisperResponseTargetSelect, whisperSegmentMsInput].forEach(input => {
            if (input) input.disabled = provider !== 'whisper';
        });
    };

    // Add event listeners for all inputs
    const inputs = [
        azureKeyInput,
        azureRegionInput,
        whisperCommandInput,
        whisperModelInput,
        whisperLanguageInput,
        whisperDeviceSelect,
        whisperCaptureModeSelect,
        whisperResponseTargetSelect,
        whisperSegmentMsInput,
        geminiKeyInput,
        openaiModelInput,
        windowGapInput,
        personalDetailsInput,
        candidateResumeInput,
        jobDescriptionInput
    ];

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    if (speechProviderSelect) {
        speechProviderSelect.addEventListener('change', () => {
            updateSpeechFieldStates();
            saveSettings();
        });
    }

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            // use electronAPI so main broadcast is consistent
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ codingLanguage: lang });
            } else {
                // fallback
                saveSettings();
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    updateSpeechFieldStates();

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assests/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assests/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('div');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                
                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });
}); 
