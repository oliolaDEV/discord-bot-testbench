# Messages, Components v2 and modals

Plain messages and embeds work alongside Components v2. Layout elements are preserved when messages are sent, captured, edited or read. Interactions target the actionable controls inside those layouts.

| Component | Behavior tested |
| --- | --- |
| Container, section, separator | Preserved in the message tree and matched by type |
| Text display | Text can be matched with `contains` |
| Thumbnail, media gallery, file display | Metadata and nesting are preserved; media rendering and downloads are not tested |
| Button | Handler dispatch, including section accessories and controls inside containers |
| String, user, role, mentionable, channel selects | Handler dispatch with selected values and resolved guild resources |
| Text input | Native modal text getters |
| Radio group | Selected string or an optional `null` |
| Checkbox group | Selected option values, including an empty selection when optional |
| Checkbox | Boolean state; `false` is preserved |
| File upload | Attachment metadata from an existing message in the allowed test channel |

Checkboxes, checkbox groups and radio groups are modal fields. Containers and separators are layout elements; they do not produce click interactions. Link buttons do not produce component callbacks. Native Python checkbox, radio and upload widgets require discord.py 2.7; the older adapter support remains available for features in discord.py 2.6.

## Send or inspect a layout

`testbench_send` accepts either `content` or a `message` object. Set flag `32768` (`IsComponentsV2`) for a Components v2 message:

```json
{
  "channelId": "100000000000000002",
  "message": {
    "flags": 32768,
    "components": [
      {
        "type": 17,
        "components": [
          { "type": 10, "content": "Ticket settings" },
          { "type": 14, "divider": true, "spacing": 1 }
        ]
      }
    ]
  }
}
```

In a bot handler, use normal discord.js Components v2 builders and flags. The Python adapter sets the Components v2 flag when the supplied LayoutView contains v2 components. Private captures preserve both the v2 and ephemeral flags, including subsequent edits.

`testbench_assert` can match `contains`, an exact `componentId`, and/or a numeric `componentType`. The component search traverses containers, sections, action rows, labels and accessories. When both custom ID and type are provided, they must identify the same component. `contains` searches ordinary message content and nested text displays; embed titles use `embedTitle`.

## Submit typed modal fields

The existing `fields` object still accepts legacy text inputs. Use `modalFields` for typed inputs; its custom IDs must be unique across both forms.

```json
{
  "interaction": {
    "kind": "modal",
    "customId": "preferences:submit",
    "channelId": "100000000000000002",
    "userId": "100000000000000003",
    "modalFields": [
      { "type": 23, "customId": "consent", "value": true },
      { "type": 21, "customId": "priority", "value": "high" },
      { "type": 22, "customId": "days", "values": ["monday", "friday"] },
      { "type": 8, "customId": "channel", "values": ["100000000000000002"] }
    ]
  }
}
```

Supported field types are string select `3`, text input `4`, user select `5`, role select `6`, mentionable select `7`, channel select `8`, file upload `19`, radio group `21`, checkbox group `22` and checkbox `23`. Text/radio/checkbox inputs use `value`; selects, groups and uploads use `values`.

The adapter constructs Discord-shaped Label submissions and resolves user, role and channel IDs from the configured guild. Native discord.js field getters and discord.py UI item values receive the appropriate values and resource objects. The HTTP adapters receive the same typed payload.

When a previous interaction opened the modal with `showModal`, the controller caches its definition for that channel and test user. Submissions are checked for field types, missing inputs, text length, option membership, selection counts and allowed channel types before handler dispatch. Definitions are in memory and are lost on restart. A direct submission without a cached definition still reaches the handler but does not reproduce complete client validation.

## File-upload metadata

For a type `19` field, provide `attachmentMessageId` pointing to an existing message in the same allowed channel and set `values` to attachment IDs on that message. The adapter resolves their actual metadata; arbitrary invented attachment IDs are rejected.

This simulates the modal submission after a file has been uploaded. It does not upload new bytes from the user's device, exercise Discord's upload UI or check that a displayed media file renders successfully.
