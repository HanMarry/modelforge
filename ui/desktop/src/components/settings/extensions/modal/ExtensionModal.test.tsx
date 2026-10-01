import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, type RenderOptions, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ExtensionModal from './ExtensionModal';
import {
  createExtensionConfig,
  ExtensionFormData,
  extensionToFormData,
  getDefaultFormData,
} from '../utils';
import { IntlTestWrapper } from '../../../../i18n/test-utils';
import { acpUpsertConfig } from '../../../../acp/config';

vi.mock('../../../../acp/config', async () => {
  const actual =
    await vi.importActual<typeof import('../../../../acp/config')>('../../../../acp/config');
  return {
    ...actual,
    acpUpsertConfig: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedUpsertConfig = vi.mocked(acpUpsertConfig);

const renderWithIntl = (ui: React.ReactElement, options?: RenderOptions) =>
  render(ui, { wrapper: IntlTestWrapper, ...options });

describe('ExtensionModal', () => {
  it('does not show unsaved changes dialog when closing without modifications', async () => {
    const user = userEvent.setup();
    const mockOnSubmit = vi.fn();
    const mockOnClose = vi.fn();

    const initialData: ExtensionFormData = {
      name: 'Existing Extension',
      description: 'An existing extension',
      type: 'stdio',
      cmd: 'npx some-mcp-server',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [
        { key: 'API_KEY', value: '••••••••', isEdited: false },
        { key: 'OTHER_VAR', value: '••••••••', isEdited: false },
      ],
      headers: [],
    };

    renderWithIntl(
      <ExtensionModal
        title="Edit Extension"
        initialData={initialData}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        submitLabel="Save"
        modalType="edit"
      />
    );

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    expect(mockOnClose).toHaveBeenCalled();

    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
  });

  it('shows unsaved changes dialog when name is modified', async () => {
    const user = userEvent.setup();
    const mockOnSubmit = vi.fn();
    const mockOnClose = vi.fn();

    const initialData: ExtensionFormData = {
      name: 'Original Name',
      description: 'An existing extension',
      type: 'stdio',
      cmd: 'npx some-mcp-server',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [],
      headers: [],
    };

    renderWithIntl(
      <ExtensionModal
        title="Edit Extension"
        initialData={initialData}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        submitLabel="Save"
        modalType="edit"
      />
    );

    const nameInput = screen.getByPlaceholderText('Enter extension name...');
    await user.clear(nameInput);
    await user.type(nameInput, 'New Name');

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it('shows unsaved changes dialog when description is modified', async () => {
    const user = userEvent.setup();
    const mockOnSubmit = vi.fn();
    const mockOnClose = vi.fn();

    const initialData: ExtensionFormData = {
      name: 'Test Extension',
      description: 'Original description',
      type: 'stdio',
      cmd: 'npx some-mcp-server',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [],
      headers: [],
    };

    renderWithIntl(
      <ExtensionModal
        title="Edit Extension"
        initialData={initialData}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        submitLabel="Save"
        modalType="edit"
      />
    );

    const descriptionInput = screen.getByPlaceholderText('Optional description...');
    await user.clear(descriptionInput);
    await user.type(descriptionInput, 'New description');

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it('shows unsaved changes dialog when timeout is modified', async () => {
    const user = userEvent.setup();
    const mockOnSubmit = vi.fn();
    const mockOnClose = vi.fn();

    const initialData: ExtensionFormData = {
      name: 'Test Extension',
      description: 'An extension',
      type: 'stdio',
      cmd: 'npx some-mcp-server',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [],
      headers: [],
    };

    renderWithIntl(
      <ExtensionModal
        title="Edit Extension"
        initialData={initialData}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        submitLabel="Save"
        modalType="edit"
      />
    );

    const timeoutInput = screen.getByDisplayValue('300');
    await user.clear(timeoutInput);
    await user.type(timeoutInput, '600');

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it('creates a http_streamable extension', async () => {
    const user = userEvent.setup();
    const mockOnSubmit = vi.fn();
    const mockOnClose = vi.fn();

    const initialData: ExtensionFormData = {
      name: '',
      description: '',
      type: 'stdio', // Default type
      cmd: '',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [],
      headers: [],
    };

    renderWithIntl(
      <ExtensionModal
        title="Add custom extension"
        initialData={initialData}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        submitLabel="Add Extension"
        modalType="add"
      />
    );

    const nameInput = screen.getByPlaceholderText('Enter extension name...');
    const submitButton = screen.getByTestId('extension-submit-btn');

    await user.type(nameInput, 'Test MCP');

    const typeSelect = screen.getByRole('combobox');
    await user.click(typeSelect);

    const httpOption = screen.getByText('Streamable HTTP');
    await user.click(httpOption);

    await waitFor(() => {
      expect(screen.getByText('Request Headers')).toBeInTheDocument();
    });

    const endpointInput = screen.getByPlaceholderText('Enter endpoint URL...');
    await user.type(endpointInput, 'https://foo.bar.com/mcp/');

    const descriptionInput = screen.getByPlaceholderText('Optional description...');
    await user.type(descriptionInput, 'Test MCP extension');

    const headerNameInput = screen.getByPlaceholderText('Header name');
    const headerValueInput = screen
      .getAllByPlaceholderText('Value')
      .find(
        (input) =>
          input.closest('div')?.textContent?.includes('Request Headers') ||
          input.parentElement?.parentElement?.textContent?.includes('Request Headers')
      );

    await user.type(headerNameInput, 'Authorization');
    if (headerValueInput) {
      await user.type(headerValueInput, 'Bearer abc123');
    }

    await user.click(submitButton);

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalled();
    });

    const submittedData = mockOnSubmit.mock.calls[0][0];

    expect(submittedData.name).toBe('Test MCP');
    expect(submittedData.type).toBe('streamable_http');
    expect(submittedData.endpoint).toBe('https://foo.bar.com/mcp/');
    expect(submittedData.description).toBe('Test MCP extension');
    expect(submittedData.timeout).toBe(300);
    expect(submittedData.headers).toHaveLength(1);
    expect(submittedData.headers).toEqual([
      { key: 'Authorization', value: 'Bearer abc123', isEdited: true, sensitive: true },
    ]);
  }, 15000);

  describe('sensitive request headers (requirements 1.1, 1.3, 1.11)', () => {
    const STORED_AUTHORIZATION =
      '${secret:extension_github__header__authorization_0123456789abcdef}';
    const STORED_TENANT = '${secret:extension_github__header__x_tenant_0123456789abcdef}';

    const savedValueLabel = (name: string) =>
      `Saved value of ${name} is hidden. Type a new value to replace it.`;

    /** An extension whose sensitive headers are already in the credential store. */
    function savedExtension(): ExtensionFormData {
      return extensionToFormData({
        type: 'streamable_http',
        name: 'GitHub',
        description: 'GitHub MCP',
        uri: 'https://example.com/mcp',
        enabled: true,
        timeout: 300,
        headers: {
          Authorization: STORED_AUTHORIZATION,
          'X-Tenant': STORED_TENANT,
          'X-Trace': 'trace-1',
        },
        env_keys: [],
      });
    }

    function renderModal(
      initialData: ExtensionFormData,
      onSubmit: (formData: ExtensionFormData) => void | Promise<void>,
      modalType: 'add' | 'edit' = 'edit'
    ) {
      const onClose = vi.fn();
      renderWithIntl(
        <ExtensionModal
          title="Edit Extension"
          initialData={initialData}
          onClose={onClose}
          onSubmit={onSubmit}
          submitLabel="Save"
          modalType={modalType}
        />
      );
      return onClose;
    }

    function headersSection(): HTMLElement {
      const section = screen.getByText('Request Headers').parentElement?.parentElement;
      if (!section) {
        throw new Error('Request Headers section not found');
      }
      return section;
    }

    /** The inputs of the empty header row come after the rows of the saved headers. */
    function lastInHeaders(placeholder: string): HTMLElement {
      const inputs = within(headersSection()).getAllByPlaceholderText(placeholder);
      return inputs[inputs.length - 1];
    }

    it('locks auth header names as sensitive and lets the user mark other headers', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderModal(
        {
          ...getDefaultFormData(),
          name: 'Gateway',
          type: 'streamable_http',
          endpoint: 'https://example.com/mcp',
        },
        onSubmit,
        'add'
      );

      await user.type(lastInHeaders('Header name'), 'x-api-key');
      const newRowSensitive = screen.getByLabelText('Mark the new header as sensitive');
      expect(newRowSensitive).toBeChecked();
      expect(newRowSensitive).toBeDisabled();
      expect(lastInHeaders('Value')).toHaveAttribute('type', 'password');
      await user.type(lastInHeaders('Value'), 'sk-1');
      await user.click(within(headersSection()).getByRole('button', { name: /Add/ }));

      expect(screen.getByLabelText('Mark x-api-key as sensitive')).toBeChecked();
      expect(screen.getByLabelText('Mark x-api-key as sensitive')).toBeDisabled();

      await user.type(lastInHeaders('Header name'), 'X-Tenant-Id');
      expect(screen.getByLabelText('Mark the new header as sensitive')).not.toBeChecked();
      expect(screen.getByLabelText('Mark the new header as sensitive')).toBeEnabled();
      await user.click(screen.getByLabelText('Mark the new header as sensitive'));
      await user.type(lastInHeaders('Value'), 'tenant-1');
      expect(screen.getByDisplayValue('tenant-1')).toHaveAttribute('type', 'password');

      // The second header is still pending; submitting picks it up with its mark.
      await user.click(screen.getByTestId('extension-submit-btn'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });

      const submitted: ExtensionFormData = onSubmit.mock.calls[0][0];
      expect(submitted.headers).toEqual([
        { key: 'x-api-key', value: 'sk-1', isEdited: true, sensitive: true },
        { key: 'X-Tenant-Id', value: 'tenant-1', isEdited: true, sensitive: true },
      ]);
      // Marks travel as env_keys; auth header names are sensitive on the Kernel side anyway.
      expect(createExtensionConfig(submitted)).toMatchObject({
        env_keys: ['X-Tenant-Id'],
        headers: { 'x-api-key': 'sk-1', 'X-Tenant-Id': 'tenant-1' },
      });
    }, 15000);

    it('shows saved sensitive values only as a mask and sends them back unchanged', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderModal(savedExtension(), onSubmit);

      expect(screen.queryByDisplayValue(/secret:/)).not.toBeInTheDocument();
      const savedAuthorization = screen.getByLabelText(savedValueLabel('Authorization'));
      expect(savedAuthorization).toHaveValue('');
      expect(savedAuthorization).toHaveAttribute('placeholder', '••••••••');
      expect(savedAuthorization).toHaveAttribute('type', 'password');
      expect(screen.getByLabelText(savedValueLabel('X-Tenant'))).toHaveValue('');
      expect(screen.getByLabelText('Mark Authorization as sensitive')).toBeChecked();
      expect(screen.getByLabelText('Mark Authorization as sensitive')).toBeDisabled();
      expect(screen.getByLabelText('Mark X-Tenant as sensitive')).toBeChecked();
      expect(screen.getByLabelText('Mark X-Tenant as sensitive')).toBeEnabled();
      expect(screen.getByDisplayValue('trace-1')).toHaveAttribute('type', 'text');

      await user.click(screen.getByTestId('extension-submit-btn'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });

      const config = createExtensionConfig(onSubmit.mock.calls[0][0]);
      expect(config).toMatchObject({
        headers: {
          Authorization: STORED_AUTHORIZATION,
          'X-Tenant': STORED_TENANT,
          'X-Trace': 'trace-1',
        },
      });
      expect(config).not.toHaveProperty('env_keys');
    }, 15000);

    it('asks for the saved values again when the extension is renamed', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderModal(savedExtension(), onSubmit);

      const nameInput = screen.getByPlaceholderText('Enter extension name...');
      await user.clear(nameInput);
      await user.type(nameInput, 'GitHub Work');

      expect(
        screen.getByText(/After renaming, enter them again: Authorization, X-Tenant$/)
      ).toBeInTheDocument();
      expect(screen.getByTestId('extension-submit-btn')).toBeDisabled();

      await user.type(screen.getByLabelText(savedValueLabel('Authorization')), 'Bearer new');
      await user.type(screen.getByLabelText(savedValueLabel('X-Tenant')), 'tenant-2');
      expect(screen.queryByText(/enter them again:/)).not.toBeInTheDocument();

      await user.click(screen.getByTestId('extension-submit-btn'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });

      expect(createExtensionConfig(onSubmit.mock.calls[0][0])).toMatchObject({
        name: 'GitHub Work',
        env_keys: ['X-Tenant'],
        headers: { Authorization: 'Bearer new', 'X-Tenant': 'tenant-2', 'X-Trace': 'trace-1' },
      });
    }, 15000);

    it('keeps the entries and shows why when saving fails', async () => {
      const user = userEvent.setup();
      const onSubmit = vi
        .fn()
        .mockRejectedValue(
          new Error('CREDENTIAL_WRITE_FAILED: extension GitHub: the keyring is locked')
        );
      const onClose = renderModal(savedExtension(), onSubmit);

      await user.type(screen.getByLabelText(savedValueLabel('Authorization')), 'Bearer new');
      await user.click(screen.getByTestId('extension-submit-btn'));

      expect(
        await screen.findByText(
          'Could not save GitHub: CREDENTIAL_WRITE_FAILED: extension GitHub: the keyring is locked. Your entries are kept, so you can try again.'
        )
      ).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue('Bearer new')).toBeInTheDocument();
      expect(screen.getByTestId('extension-submit-btn')).toBeEnabled();
    }, 15000);
  });

  describe('pending env var capture (fix for #8969)', () => {
    beforeEach(() => {
      mockedUpsertConfig.mockClear();
      mockedUpsertConfig.mockResolvedValue(undefined);
    });

    const emptyInitialData: ExtensionFormData = {
      name: '',
      description: '',
      type: 'stdio',
      cmd: '',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [],
      headers: [],
    };

    // Returns the env-var key+value inputs (scoped to the "Environment Variables" section,
    // disambiguated from the header inputs which share the "Value" placeholder).
    function getEnvVarInputs() {
      const envVarKeyInput = screen.getByPlaceholderText('Variable name');
      const envVarValueInput = screen
        .getAllByPlaceholderText('Value')
        .find((input) =>
          input.parentElement?.parentElement?.parentElement?.textContent?.includes(
            'Environment Variables'
          )
        );
      return { envVarKeyInput, envVarValueInput };
    }

    it('captures a pending env var typed but not "+ Added" when Submit is clicked', async () => {
      const user = userEvent.setup();
      const mockOnSubmit = vi.fn();
      const mockOnClose = vi.fn();

      renderWithIntl(
        <ExtensionModal
          title="Add custom extension"
          initialData={emptyInitialData}
          onClose={mockOnClose}
          onSubmit={mockOnSubmit}
          submitLabel="Add Extension"
          modalType="add"
        />
      );

      await user.type(screen.getByPlaceholderText('Enter extension name...'), 'WooMCP');
      await user.type(
        screen.getByPlaceholderText(/^e\.g\. npx/),
        'npx -y @automattic/mcp-wordpress-remote@latest'
      );

      const { envVarKeyInput, envVarValueInput } = getEnvVarInputs();
      await user.type(envVarKeyInput, 'JWT_TOKEN');
      if (envVarValueInput) {
        await user.type(envVarValueInput, 'my_very_long_token');
      }

      // Note: intentionally NOT clicking the "+ Add" button — this is the #8969 repro.
      await user.click(screen.getByTestId('extension-submit-btn'));

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalled();
      });

      expect(mockedUpsertConfig).toHaveBeenCalledWith('JWT_TOKEN', 'my_very_long_token', true);

      const submittedData = mockOnSubmit.mock.calls[0][0];
      expect(submittedData.envVars).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'JWT_TOKEN',
            value: 'my_very_long_token',
            isEdited: true,
          }),
        ])
      );
    }, 15000);

    it('does not capture a pending env var when only the key is filled', async () => {
      const user = userEvent.setup();
      const mockOnSubmit = vi.fn();
      const mockOnClose = vi.fn();

      renderWithIntl(
        <ExtensionModal
          title="Add custom extension"
          initialData={emptyInitialData}
          onClose={mockOnClose}
          onSubmit={mockOnSubmit}
          submitLabel="Add Extension"
          modalType="add"
        />
      );

      await user.type(screen.getByPlaceholderText('Enter extension name...'), 'WooMCP');
      await user.type(screen.getByPlaceholderText(/^e\.g\. npx/), 'npx -y something');

      const { envVarKeyInput } = getEnvVarInputs();
      await user.type(envVarKeyInput, 'LONELY_KEY');
      // Intentionally leaving the value field empty.

      await user.click(screen.getByTestId('extension-submit-btn'));

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalled();
      });

      expect(mockedUpsertConfig).not.toHaveBeenCalledWith(
        'LONELY_KEY',
        expect.anything(),
        expect.anything()
      );

      const submittedData = mockOnSubmit.mock.calls[0][0];
      expect(submittedData.envVars).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'LONELY_KEY' })])
      );
    }, 15000);
  });
});
