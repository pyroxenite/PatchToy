import { config } from '../core/config.js';

/**
 * API client for backend communication
 */
export class ApiClient {
  constructor() {
    this.baseUrl = config.API_URL;
    this.token = localStorage.getItem('patchtoy_auth_token');
  }

  /**
   * Check if backend is enabled
   */
  isEnabled() {
    return this.baseUrl !== null && this.baseUrl !== undefined;
  }

  /**
   * Check if user is logged in
   */
  isLoggedIn() {
    return this.token !== null;
  }

  /**
   * Get current user info from token
   */
  getCurrentUser() {
    if (!this.token) return null;

    try {
      // Decode JWT payload (simple base64 decode, not verification)
      const payload = JSON.parse(atob(this.token.split('.')[1]));
      return {
        userId: payload.userId,
        email: payload.email,
        username: payload.username,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Set auth token
   */
  setToken(token) {
    this.token = token;
    localStorage.setItem('patchtoy_auth_token', token);
  }

  /**
   * Clear auth token
   */
  clearToken() {
    this.token = null;
    localStorage.removeItem('patchtoy_auth_token');
  }

  /**
   * Make authenticated request
   */
  async request(method, path, body = null) {
    if (!this.isEnabled()) {
      throw new Error('Backend not configured');
    }

    const headers = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const options = {
      method,
      headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, options);

    if (response.status === 401) {
      // Token expired or invalid
      this.clearToken();
      throw new Error('Authentication required');
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }

    return data;
  }

  // Auth endpoints
  async register(email, username, password) {
    console.log('Register request:', { email, username, password: '***' });
    const data = await this.request('POST', '/api/auth/register', { email, username, password });
    console.log('Register response:', data);
    this.setToken(data.token);
    return data;
  }

  async login(login, password) {
    console.log('Login request:', { login, password: '***' });
    const data = await this.request('POST', '/api/auth/login', { login, password });
    console.log('Login response:', data);
    this.setToken(data.token);
    return data;
  }

  async logout() {
    this.clearToken();
  }

  async verify() {
    return await this.request('GET', '/api/auth/verify');
  }

  // Project endpoints
  async listProjects() {
    return await this.request('GET', '/api/projects');
  }

  async getProject(projectId) {
    return await this.request('GET', `/api/projects/${projectId}`);
  }

  async saveProject(name, data) {
    return await this.request('POST', '/api/projects', { name, data });
  }

  async updateProject(projectId, updates) {
    return await this.request('PUT', `/api/projects/${projectId}`, updates);
  }

  async deleteProject(projectId) {
    return await this.request('DELETE', `/api/projects/${projectId}`);
  }

  async toggleProjectVisibility(projectId, isPublic) {
    return await this.request('PUT', `/api/projects/${projectId}/visibility`, { isPublic });
  }

  /**
   * Get public project (no auth required)
   */
  async getPublicProject(projectId) {
    if (!this.isEnabled()) {
      throw new Error('Backend not configured');
    }

    const response = await fetch(`${this.baseUrl}/api/projects/${projectId}`);

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Request failed');
    }

    return await response.json();
  }
}
