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
}
