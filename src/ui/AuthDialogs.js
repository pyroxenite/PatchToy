import { UIHelpers, h } from './UIHelpers.js';

/**
 * Login / register / password reset dialogs (built on UIHelpers.createModal).
 */
export class AuthDialogs {
    static showLogin(apiClient, onSuccess) {
        const m = UIHelpers.createModal({
            title: 'Welcome back',
            subtitle: 'Sign in to save projects to the cloud and share links.',
            brand: true
        });

        const login = UIHelpers.field({ label: 'Email or username', placeholder: 'you@example.com', autocomplete: 'username' });
        const password = UIHelpers.field({ label: 'Password', type: 'password', autocomplete: 'current-password' });
        m.body.append(login.field, password.field);

        const links = h('div', { className: 'pt-modal-links' });
        const forgot = h('a', { href: '#', text: 'Forgot password?' });
        forgot.addEventListener('click', (e) => {
            e.preventDefault();
            m.close();
            AuthDialogs.showForgotPassword(apiClient);
        });
        // Shown after a failed sign-in: an unconfirmed sign-up fails like a wrong password
        const resend = h('a', { href: '#', text: 'Didn’t confirm your email?', className: 'pt-auth-resend' });
        resend.hidden = true;
        resend.addEventListener('click', (e) => {
            e.preventDefault();
            const typed = login.input.value.trim();
            m.close();
            AuthDialogs.showResendVerification(apiClient, { email: typed.includes('@') ? typed : '', onSuccess });
        });
        const left = h('span');
        left.appendChild(resend);
        links.append(left, forgot);
        m.body.appendChild(links);

        const loginBtn = UIHelpers.button('Sign in', { variant: 'primary', size: 'lg', block: true });
        m.footer.appendChild(loginBtn);

        const alt = h('div', { className: 'pt-modal-alt' });
        alt.append('New to PatchToy? ');
        const reg = h('a', { href: '#', text: 'Create an account' });
        reg.addEventListener('click', (e) => {
            e.preventDefault();
            m.close();
            AuthDialogs.showRegister(apiClient, onSuccess);
        });
        alt.appendChild(reg);
        m.modal.appendChild(alt);

        const handleLogin = async () => {
            const loginValue = login.input.value.trim();
            const passwordValue = password.input.value;

            if (!loginValue || !passwordValue) {
                m.setError('Enter your email or username and password.');
                return;
            }

            try {
                loginBtn.disabled = true;
                loginBtn.setLabel('Signing in…');
                m.setError(null);

                await apiClient.login(loginValue, passwordValue);

                m.close();
                UIHelpers.toast(`Signed in as @${apiClient.getCurrentUser()?.username || loginValue}`, 'success');
                if (onSuccess) onSuccess();
            } catch (err) {
                m.setError(err.status === 401
                    ? 'Wrong email, username or password. Signed up recently? Confirm your email first.'
                    : (err.message || 'Login failed'));
                if (err.status === 401) resend.hidden = false;
                loginBtn.disabled = false;
                loginBtn.setLabel('Sign in');
            }
        };

        loginBtn.addEventListener('click', handleLogin);
        [login.input, password.input].forEach(inp => inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleLogin();
        }));

        setTimeout(() => login.input.focus(), 0);
        return m;
    }

    static showRegister(apiClient, onSuccess) {
        const m = UIHelpers.createModal({
            title: 'Create your account',
            subtitle: 'Save patches to the cloud and share them with a link.',
            brand: true
        });

        const email = UIHelpers.field({ label: 'Email', type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
        const username = UIHelpers.field({ label: 'Username', placeholder: 'shaderwizard', hint: '3–20 characters: letters, numbers, _ and -', autocomplete: 'username' });
        const password = UIHelpers.field({ label: 'Password', type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
        m.body.append(email.field, username.field, password.field);

        const registerBtn = UIHelpers.button('Create account', { variant: 'primary', size: 'lg', block: true });
        m.footer.appendChild(registerBtn);

        const alt = h('div', { className: 'pt-modal-alt' });
        alt.append('Already have an account? ');
        const loginLink = h('a', { href: '#', text: 'Sign in' });
        loginLink.addEventListener('click', (e) => {
            e.preventDefault();
            m.close();
            AuthDialogs.showLogin(apiClient, onSuccess);
        });
        alt.appendChild(loginLink);
        m.modal.appendChild(alt);

        const handleRegister = async () => {
            const emailValue = email.input.value.trim();
            const usernameValue = username.input.value.trim();
            const passwordValue = password.input.value;

            if (!emailValue || !usernameValue || !passwordValue) {
                m.setError('All fields are required.');
                return;
            }

            try {
                registerBtn.disabled = true;
                registerBtn.setLabel('Creating account…');
                m.setError(null);

                const result = await apiClient.register(emailValue, usernameValue, passwordValue);

                m.close();
                if (result.pending) {
                    // Same answer whether or not the address already has an account (no enumeration)
                    AuthDialogs.showCheckEmail(apiClient, { email: emailValue, onSuccess });
                    return;
                }
                UIHelpers.toast(`Welcome, @${apiClient.getCurrentUser()?.username || usernameValue}!`, 'success');
                if (onSuccess) onSuccess();
            } catch (err) {
                m.setError(err.message || 'Registration failed');
                registerBtn.disabled = false;
                registerBtn.setLabel('Create account');
            }
        };

        registerBtn.addEventListener('click', handleRegister);
        [email.input, username.input, password.input].forEach(inp => inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleRegister();
        }));

        setTimeout(() => email.input.focus(), 0);
        return m;
    }

    /**
     * After sign-up: "check your email". The link in the mail (/#verify=<token>) creates
     * the account and signs in (completeSignup). Resend has a client-side cooldown on top
     * of the server's per-address limits.
     */
    static showCheckEmail(apiClient, { email = '', onSuccess = null } = {}) {
        const m = UIHelpers.createModal({
            title: 'Check your email',
            subtitle: '',
            brand: true,
            className: 'pt-modal--check-email'
        });
        m.subtitleEl.hidden = false;
        m.subtitleEl.textContent = email
            ? `We sent a link to ${email}. Open it to finish creating your account.`
            : 'We sent you a link. Open it to finish creating your account.';
        m.body.appendChild(h('p', {
            className: 'pt-field-hint',
            text: 'The link works once and expires in 24 hours. If this address already has an account, the email says so instead: sign in, or reset your password. Nothing in the mail? Check your spam folder, or send it again.'
        }));

        const backBtn = UIHelpers.button('Back to sign in', { variant: 'ghost' });
        const resendBtn = UIHelpers.button('Resend email', { variant: 'primary' });
        m.footer.append(backBtn, resendBtn);
        backBtn.addEventListener('click', () => {
            m.close();
            AuthDialogs.showLogin(apiClient, onSuccess);
        });
        // The sign-up mail just went out: a resend makes sense after a minute
        AuthDialogs.wireResend(m, resendBtn, apiClient, () => email, { coolingDown: true });
        return m;
    }

    /** "Resend the confirmation email" (from the sign-in dialog). */
    static showResendVerification(apiClient, { email = '', onSuccess = null } = {}) {
        const m = UIHelpers.createModal({
            title: 'Confirm your email',
            subtitle: 'Signed up but lost the email? Enter your address and we’ll send a new link.'
        });
        const field = UIHelpers.field({ label: 'Email', type: 'email', placeholder: 'you@example.com', value: email, autocomplete: 'email' });
        m.body.appendChild(field.field);
        const backBtn = UIHelpers.button('Back to sign in', { variant: 'ghost' });
        const sendBtn = UIHelpers.button('Send link', { variant: 'primary' });
        m.footer.append(backBtn, sendBtn);
        backBtn.addEventListener('click', () => {
            m.close();
            AuthDialogs.showLogin(apiClient, onSuccess);
        });
        AuthDialogs.wireResend(m, sendBtn, apiClient, () => field.input.value.trim(), { label: 'Send link' });
        field.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !sendBtn.disabled) sendBtn.click();
        });
        setTimeout(() => field.input.focus(), 0);
        return m;
    }

    /** Resend button behaviour: one request, a generic answer, then a 60 s cooldown. */
    static wireResend(m, btn, apiClient, getEmail, { label = 'Resend email', cooldown = 60, coolingDown = false } = {}) {
        let timer = null;
        const startCooldown = (seconds) => {
            let left = seconds;
            btn.disabled = true;
            btn.setLabel(`${label} (${left}s)`);
            timer = setInterval(() => {
                left -= 1;
                if (left <= 0 || m.closed) {
                    clearInterval(timer);
                    btn.disabled = false;
                    btn.setLabel(label);
                    return;
                }
                btn.setLabel(`${label} (${left}s)`);
            }, 1000);
        };
        btn.addEventListener('click', async () => {
            const email = getEmail();
            if (!email) {
                m.setMessage('Enter the email address you signed up with.', 'error');
                return;
            }
            try {
                btn.disabled = true;
                btn.setLabel('Sending…');
                const r = await apiClient.resendVerification(email);
                m.setMessage(r?.message || 'If a sign-up is waiting for that address, a new link is on its way.', 'success');
                startCooldown(cooldown);
            } catch (err) {
                m.setMessage(err.message || 'Could not send the email', 'error');
                if (err.status === 429) startCooldown(cooldown);
                else {
                    btn.disabled = false;
                    btn.setLabel(label);
                }
            }
        });
        if (coolingDown) startCooldown(cooldown);
    }

    /**
     * Open a sign-up link (/#verify=<token>, read and removed from the URL by the router
     * before anything else loads): creates the account and signs in.
     */
    static async completeSignup(apiClient, token, onSuccess = null) {
        const failed = (message) => {
            const m = UIHelpers.createModal({ title: 'Sign-up link expired', subtitle: '' });
            m.subtitleEl.hidden = false;
            m.subtitleEl.textContent = message;
            m.body.remove();
            const signInBtn = UIHelpers.button('Sign in', { variant: 'ghost' });
            const again = UIHelpers.button('Send a new link', { variant: 'primary' });
            signInBtn.addEventListener('click', () => {
                m.close();
                AuthDialogs.showLogin(apiClient, onSuccess);
            });
            again.addEventListener('click', () => {
                m.close();
                AuthDialogs.showResendVerification(apiClient, { onSuccess });
            });
            m.footer.append(signInBtn, again);
            return m;
        };
        const generic = 'This sign-up link is invalid, expired or was already used. Links work once and expire after 24 hours. If you already confirmed your email, sign in.';
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(token)) {
            failed(generic);
            return false;
        }
        try {
            const data = await apiClient.verifyEmail(token);
            UIHelpers.toast('Your email is confirmed and you’re signed in.', 'success', { title: `Welcome, @${data.username}!` });
            onSuccess?.();
            return true;
        } catch (err) {
            if (err.status === 401 || err.code === 'verify_invalid') failed(generic);
            else UIHelpers.notify(err.message || 'Could not finish signing up. Open the link again.', 'error', { title: 'Sign-up not finished' });
            return false;
        }
    }

    static showForgotPassword(apiClient) {
        const m = UIHelpers.createModal({
            title: 'Reset your password',
            subtitle: 'Enter your email and we’ll send you a link to set a new password.'
        });

        const email = UIHelpers.field({ label: 'Email', type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
        m.body.appendChild(email.field);

        const backBtn = UIHelpers.button('Back to sign in', { variant: 'ghost' });
        const sendBtn = UIHelpers.button('Send reset link', { variant: 'primary' });
        m.footer.append(backBtn, sendBtn);
        backBtn.addEventListener('click', () => {
            m.close();
            AuthDialogs.showLogin(apiClient);
        });

        const handleSend = async () => {
            const emailValue = email.input.value.trim();

            if (!emailValue) {
                m.setMessage('Email is required.', 'error');
                return;
            }

            try {
                sendBtn.disabled = true;
                sendBtn.setLabel('Sending…');

                await apiClient.requestPasswordReset(emailValue);

                m.setMessage('If that email exists in our system, a reset link is on its way.', 'success');
                email.input.disabled = true;
                sendBtn.hidden = true;

                setTimeout(() => {
                    if (m.closed) return;
                    m.close();
                    AuthDialogs.showLogin(apiClient);
                }, 3000);
            } catch (err) {
                m.setMessage(err.message || 'Failed to send reset link', 'error');
                sendBtn.disabled = false;
                sendBtn.setLabel('Send reset link');
            }
        };

        sendBtn.addEventListener('click', handleSend);
        email.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleSend();
        });

        setTimeout(() => email.input.focus(), 0);
        return m;
    }

    static showResetPassword(apiClient, token) {
        // Reset links carry an opaque single-use token (32 random bytes, base64url); the
        // server checks expiry (30 minutes) and use
        const validateToken = () => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

        const m = UIHelpers.createModal({
            title: 'Set a new password',
            subtitle: ''
        });

        if (!validateToken()) {
            m.titleEl.textContent = 'Reset link expired';
            m.subtitleEl.hidden = false;
            m.subtitleEl.textContent = 'This password reset link is invalid. Reset links work once and expire after 30 minutes.';
            m.body.remove();
            const again = UIHelpers.button('Request a new link', { variant: 'primary' });
            again.addEventListener('click', () => {
                m.close();
                AuthDialogs.showForgotPassword(apiClient);
            });
            m.footer.appendChild(again);
            return m;
        }

        const password = UIHelpers.field({ label: 'New password', type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
        const confirmField = UIHelpers.field({ label: 'Confirm password', type: 'password', placeholder: 'Re-enter password', autocomplete: 'new-password' });
        m.body.append(password.field, confirmField.field);

        const resetBtn = UIHelpers.button('Update password', { variant: 'primary', size: 'lg', block: true });
        m.footer.appendChild(resetBtn);

        const handleReset = async () => {
            const pw = password.input.value;
            const confirmValue = confirmField.input.value;

            if (!pw || !confirmValue) {
                m.setError('All fields are required.');
                return;
            }
            if (pw !== confirmValue) {
                m.setError('Passwords do not match.');
                return;
            }
            if (pw.length < 8) {
                m.setError('Password must be at least 8 characters.');
                return;
            }

            try {
                resetBtn.disabled = true;
                resetBtn.setLabel('Updating…');

                await apiClient.resetPassword(token, pw);

                m.close();
                UIHelpers.toast('You were signed out everywhere. Sign in with your new password.', 'success', { title: 'Password updated' });
                AuthDialogs.showLogin(apiClient);
            } catch (err) {
                m.setError(err.message || 'Failed to reset password');
                resetBtn.disabled = false;
                resetBtn.setLabel('Update password');
            }
        };

        resetBtn.addEventListener('click', handleReset);
        confirmField.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleReset();
        });

        setTimeout(() => password.input.focus(), 0);
        return m;
    }
}
