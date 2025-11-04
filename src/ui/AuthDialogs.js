export class AuthDialogs {
    static showLogin(apiClient, onSuccess) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 10000;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background: #2d2d2d; border: 1px solid #444; border-radius: 8px; padding: 20px; width: 400px; max-width: 90vw;';

        const title = document.createElement('h2');
        title.textContent = 'Login';
        title.style.cssText = 'margin: 0 0 20px 0; color: #fff; font-size: 18px;';
        dialog.appendChild(title);

        // Login field (email or username)
        const loginLabel = document.createElement('label');
        loginLabel.textContent = 'Email or Username';
        loginLabel.style.cssText = 'display: block; color: #ccc; margin-bottom: 5px;';
        const loginInput = document.createElement('input');
        loginInput.type = 'text';
        loginInput.placeholder = 'email@example.com or username';
        loginInput.style.cssText = 'width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #fff; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box;';

        // Password input
        const passwordLabel = document.createElement('label');
        passwordLabel.textContent = 'Password';
        passwordLabel.style.cssText = 'display: block; color: #ccc; margin-bottom: 5px;';
        const passwordInput = document.createElement('input');
        passwordInput.type = 'password';
        passwordInput.style.cssText = 'width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #fff; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box;';

        // Error message
        const errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'color: #f44336; margin-bottom: 15px; display: none;';

        // Login button
        const loginBtn = document.createElement('button');
        loginBtn.textContent = 'Login';
        loginBtn.style.cssText = 'width: 100%; padding: 10px; background: #007acc; border: none; border-radius: 4px; color: #fff; cursor: pointer; font-size: 14px; margin-bottom: 15px;';

        const handleLogin = async () => {
            const login = loginInput.value.trim();
            const password = passwordInput.value;

            if (!login || !password) {
                errorMsg.textContent = 'All fields are required';
                errorMsg.style.display = 'block';
                return;
            }

            try {
                loginBtn.disabled = true;
                loginBtn.textContent = 'Logging in...';

                await apiClient.login(login, password);

                overlay.remove();
                if (onSuccess) onSuccess();
            } catch (err) {
                errorMsg.textContent = err.message || 'Login failed';
                errorMsg.style.display = 'block';
                loginBtn.disabled = false;
                loginBtn.textContent = 'Login';
            }
        };

        loginBtn.addEventListener('click', handleLogin);

        // Enter key to login
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleLogin();
        });

        // Forgot password link
        const forgotLink = document.createElement('div');
        forgotLink.style.cssText = 'text-align: center; color: #888; margin-bottom: 10px; font-size: 12px;';
        forgotLink.innerHTML = '<a href="#" style="color: #007acc; text-decoration: none;">Forgot password?</a>';
        forgotLink.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            overlay.remove();
            AuthDialogs.showForgotPassword(apiClient);
        });

        // Register link
        const registerLink = document.createElement('div');
        registerLink.style.cssText = 'text-align: center; color: #ccc; margin-top: 15px;';
        registerLink.innerHTML = 'Don\'t have an account? <a href="#" style="color: #007acc; text-decoration: none;">Register</a>';
        registerLink.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            overlay.remove();
            AuthDialogs.showRegister(apiClient, onSuccess);
        });

        dialog.appendChild(loginLabel);
        dialog.appendChild(loginInput);
        dialog.appendChild(passwordLabel);
        dialog.appendChild(passwordInput);
        dialog.appendChild(errorMsg);
        dialog.appendChild(loginBtn);
        dialog.appendChild(forgotLink);
        dialog.appendChild(registerLink);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        setTimeout(() => loginInput.focus(), 0);
    }

    static showRegister(apiClient, onSuccess) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 10000;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background: #2d2d2d; border: 1px solid #444; border-radius: 8px; padding: 20px; width: 400px; max-width: 90vw;';

        const title = document.createElement('h2');
        title.textContent = 'Create Account';
        title.style.cssText = 'margin: 0 0 20px 0; color: #fff; font-size: 18px;';
        dialog.appendChild(title);

        // Email input
        const emailLabel = document.createElement('label');
        emailLabel.textContent = 'Email';
        emailLabel.style.cssText = 'display: block; color: #ccc; margin-bottom: 5px;';
        const emailInput = document.createElement('input');
        emailInput.type = 'email';
        emailInput.placeholder = 'email@example.com';
        emailInput.style.cssText = 'width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #fff; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box;';

        // Username input
        const usernameLabel = document.createElement('label');
        usernameLabel.textContent = 'Username';
        usernameLabel.style.cssText = 'display: block; color: #ccc; margin-bottom: 5px;';
        const usernameInput = document.createElement('input');
        usernameInput.type = 'text';
        usernameInput.placeholder = '3-20 characters (letters, numbers, _, -)';
        usernameInput.style.cssText = 'width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #fff; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box;';

        // Password input
        const passwordLabel = document.createElement('label');
        passwordLabel.textContent = 'Password';
        passwordLabel.style.cssText = 'display: block; color: #ccc; margin-bottom: 5px;';
        const passwordInput = document.createElement('input');
        passwordInput.type = 'password';
        passwordInput.placeholder = 'At least 8 characters';
        passwordInput.style.cssText = 'width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #fff; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box;';

        // Error message
        const errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'color: #f44336; margin-bottom: 15px; display: none;';

        // Register button
        const registerBtn = document.createElement('button');
        registerBtn.textContent = 'Create Account';
        registerBtn.style.cssText = 'width: 100%; padding: 10px; background: #007acc; border: none; border-radius: 4px; color: #fff; cursor: pointer; font-size: 14px; margin-bottom: 15px;';

        const handleRegister = async () => {
            const email = emailInput.value.trim();
            const username = usernameInput.value.trim();
            const password = passwordInput.value;

            if (!email || !username || !password) {
                errorMsg.textContent = 'All fields are required';
                errorMsg.style.display = 'block';
                return;
            }

            try {
                registerBtn.disabled = true;
                registerBtn.textContent = 'Creating account...';

                await apiClient.register(email, username, password);

                overlay.remove();
                if (onSuccess) onSuccess();
            } catch (err) {
                errorMsg.textContent = err.message || 'Registration failed';
                errorMsg.style.display = 'block';
                registerBtn.disabled = false;
                registerBtn.textContent = 'Create Account';
            }
        };

        registerBtn.addEventListener('click', handleRegister);

        // Enter key to register
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleRegister();
        });

        // Login link
        const loginLink = document.createElement('div');
        loginLink.style.cssText = 'text-align: center; color: #ccc; margin-top: 15px;';
        loginLink.innerHTML = 'Already have an account? <a href="#" style="color: #007acc; text-decoration: none;">Login</a>';
        loginLink.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            overlay.remove();
            AuthDialogs.showLogin(apiClient, onSuccess);
        });

        dialog.appendChild(emailLabel);
        dialog.appendChild(emailInput);
        dialog.appendChild(usernameLabel);
        dialog.appendChild(usernameInput);
        dialog.appendChild(passwordLabel);
        dialog.appendChild(passwordInput);
        dialog.appendChild(errorMsg);
        dialog.appendChild(registerBtn);
        dialog.appendChild(loginLink);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        setTimeout(() => emailInput.focus(), 0);
    }

    static showForgotPassword(apiClient) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 10000;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background: #2d2d2d; border: 1px solid #444; border-radius: 8px; padding: 20px; width: 400px; max-width: 90vw;';

        const title = document.createElement('h2');
        title.textContent = 'Reset Password';
        title.style.cssText = 'margin: 0 0 10px 0; color: #fff; font-size: 18px;';
        dialog.appendChild(title);

        const instructions = document.createElement('p');
        instructions.textContent = 'Enter your email address and we\'ll send you a link to reset your password.';
        instructions.style.cssText = 'color: #ccc; margin-bottom: 20px; font-size: 14px;';
        dialog.appendChild(instructions);

        // Email input
        const emailLabel = document.createElement('label');
        emailLabel.textContent = 'Email';
        emailLabel.style.cssText = 'display: block; color: #ccc; margin-bottom: 5px;';
        const emailInput = document.createElement('input');
        emailInput.type = 'email';
        emailInput.placeholder = 'email@example.com';
        emailInput.style.cssText = 'width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #fff; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box;';

        // Success/Error message
        const message = document.createElement('div');
        message.style.cssText = 'margin-bottom: 15px; display: none;';

        // Send reset link button
        const sendBtn = document.createElement('button');
        sendBtn.textContent = 'Send Reset Link';
        sendBtn.style.cssText = 'width: 100%; padding: 10px; background: #007acc; border: none; border-radius: 4px; color: #fff; cursor: pointer; font-size: 14px; margin-bottom: 15px;';

        const handleSend = async () => {
            const email = emailInput.value.trim();

            if (!email) {
                message.textContent = 'Email is required';
                message.style.color = '#f44336';
                message.style.display = 'block';
                return;
            }

            try {
                sendBtn.disabled = true;
                sendBtn.textContent = 'Sending...';

                await apiClient.requestPasswordReset(email);

                message.textContent = 'If that email exists in our system, a reset link has been sent.';
                message.style.color = '#4caf50';
                message.style.display = 'block';
                emailInput.disabled = true;
                sendBtn.style.display = 'none';

                // Show back to login link after success
                setTimeout(() => {
                    overlay.remove();
                    AuthDialogs.showLogin(apiClient);
                }, 3000);
            } catch (err) {
                message.textContent = err.message || 'Failed to send reset link';
                message.style.color = '#f44336';
                message.style.display = 'block';
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send Reset Link';
            }
        };

        sendBtn.addEventListener('click', handleSend);

        // Enter key to send
        emailInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleSend();
        });

        // Back to login link
        const backLink = document.createElement('div');
        backLink.style.cssText = 'text-align: center; color: #ccc;';
        backLink.innerHTML = '<a href="#" style="color: #007acc; text-decoration: none;">Back to login</a>';
        backLink.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            overlay.remove();
            AuthDialogs.showLogin(apiClient);
        });

        dialog.appendChild(emailLabel);
        dialog.appendChild(emailInput);
        dialog.appendChild(message);
        dialog.appendChild(sendBtn);
        dialog.appendChild(backLink);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        setTimeout(() => emailInput.focus(), 0);
    }

    static showResetPassword(apiClient, token) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 10000;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background: #2d2d2d; border: 1px solid #444; border-radius: 8px; padding: 20px; width: 400px; max-width: 90vw;';

        const title = document.createElement('h2');
        title.textContent = 'Set New Password';
        title.style.cssText = 'margin: 0 0 20px 0; color: #fff; font-size: 18px;';
        dialog.appendChild(title);

        // Validate token immediately on load
        const validateToken = async () => {
            try {
                // Decode JWT to check expiry without server call
                const parts = token.split('.');
                if (parts.length !== 3) {
                    throw new Error('Invalid token format');
                }

                const payload = JSON.parse(atob(parts[1]));
                const now = Math.floor(Date.now() / 1000);

                if (payload.exp && payload.exp < now) {
                    throw new Error('EXPIRED');
                }

                if (payload.type !== 'password-reset') {
                    throw new Error('Invalid token type');
                }

                return true;
            } catch (err) {
                return false;
            }
        };

        // Check token validity before showing form
        validateToken().then(isValid => {
            if (!isValid) {
                // Show error instead of form
                const errorDiv = document.createElement('div');
                errorDiv.style.cssText = 'color: #f44336; margin-bottom: 15px;';
                errorDiv.innerHTML = `
                    <p style="margin-bottom: 10px;">⚠️ This password reset link has expired or is invalid.</p>
                    <p style="font-size: 12px; color: #ccc;">Password reset links expire after 1 minute for security.</p>
                `;
                dialog.appendChild(errorDiv);

                const backBtn = document.createElement('button');
                backBtn.textContent = 'Request New Link';
                backBtn.style.cssText = 'width: 100%; padding: 10px; background: #007acc; border: none; border-radius: 4px; color: #fff; cursor: pointer; font-size: 14px;';
                backBtn.addEventListener('click', () => {
                    overlay.remove();
                    AuthDialogs.showForgotPassword(apiClient);
                });
                dialog.appendChild(backBtn);

                overlay.appendChild(dialog);
                document.body.appendChild(overlay);

                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) overlay.remove();
                });
                return;
            }

            // Token is valid, show the form
            showForm();
        });

        const showForm = () => {

        // New password input
        const passwordLabel = document.createElement('label');
        passwordLabel.textContent = 'New Password';
        passwordLabel.style.cssText = 'display: block; color: #ccc; margin-bottom: 5px;';
        const passwordInput = document.createElement('input');
        passwordInput.type = 'password';
        passwordInput.placeholder = 'At least 8 characters';
        passwordInput.style.cssText = 'width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #fff; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box;';

        // Confirm password input
        const confirmLabel = document.createElement('label');
        confirmLabel.textContent = 'Confirm Password';
        confirmLabel.style.cssText = 'display: block; color: #ccc; margin-bottom: 5px;';
        const confirmInput = document.createElement('input');
        confirmInput.type = 'password';
        confirmInput.placeholder = 'Re-enter password';
        confirmInput.style.cssText = 'width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #fff; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box;';

        // Error message
        const errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'color: #f44336; margin-bottom: 15px; display: none;';

        // Reset button
        const resetBtn = document.createElement('button');
        resetBtn.textContent = 'Reset Password';
        resetBtn.style.cssText = 'width: 100%; padding: 10px; background: #007acc; border: none; border-radius: 4px; color: #fff; cursor: pointer; font-size: 14px;';

        const handleReset = async () => {
            const password = passwordInput.value;
            const confirm = confirmInput.value;

            if (!password || !confirm) {
                errorMsg.textContent = 'All fields are required';
                errorMsg.style.display = 'block';
                return;
            }

            if (password !== confirm) {
                errorMsg.textContent = 'Passwords do not match';
                errorMsg.style.display = 'block';
                return;
            }

            if (password.length < 8) {
                errorMsg.textContent = 'Password must be at least 8 characters';
                errorMsg.style.display = 'block';
                return;
            }

            try {
                resetBtn.disabled = true;
                resetBtn.textContent = 'Resetting...';

                await apiClient.resetPassword(token, password);

                overlay.remove();
                alert('Password successfully reset! Please log in with your new password.');
                AuthDialogs.showLogin(apiClient);
            } catch (err) {
                // Improve error messages
                let errorText = err.message || 'Failed to reset password';

                if (errorText.includes('Authentication required') || errorText.includes('expired')) {
                    errorText = 'Reset link has expired. Please request a new one.';
                } else if (errorText.includes('Invalid') && errorText.includes('token')) {
                    errorText = 'Invalid reset link. Please request a new one.';
                }

                errorMsg.textContent = errorText;
                errorMsg.style.display = 'block';
                resetBtn.disabled = false;
                resetBtn.textContent = 'Reset Password';
            }
        };

        resetBtn.addEventListener('click', handleReset);

        // Enter key to reset
        confirmInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleReset();
        });

        dialog.appendChild(passwordLabel);
        dialog.appendChild(passwordInput);
        dialog.appendChild(confirmLabel);
        dialog.appendChild(confirmInput);
        dialog.appendChild(errorMsg);
        dialog.appendChild(resetBtn);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        setTimeout(() => passwordInput.focus(), 0);
        };
    }
}
