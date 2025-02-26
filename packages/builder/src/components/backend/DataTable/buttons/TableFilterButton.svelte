<script>
  import { createEventDispatcher } from "svelte"
  import { ActionButton, Drawer, DrawerContent, Button } from "@budibase/bbui"
  import FilterBuilder from "components/design/settings/controls/FilterEditor/FilterBuilder.svelte"
  import { getUserBindings } from "dataBinding"
  import { makePropSafe } from "@budibase/string-templates"

  export let schema
  export let filters
  export let disabled = false
  export let tableId

  const dispatch = createEventDispatcher()

  let drawer

  $: tempValue = filters || []
  $: schemaFields = Object.entries(schema || {}).map(
    ([fieldName, fieldSchema]) => ({
      name: fieldName, // Using the key as name if not defined in the schema, for example in some autogenerated columns
      ...fieldSchema,
    })
  )

  $: text = getText(filters)
  $: selected = tempValue.filter(x => !x.onEmptyFilter)?.length > 0
  $: bindings = [
    {
      type: "context",
      runtimeBinding: `${makePropSafe("now")}`,
      readableBinding: `Date`,
      category: "Date",
      icon: "Date",
      display: {
        name: "Server date",
      },
    },
    ...getUserBindings(),
  ]
  const getText = filters => {
    const count = filters?.filter(filter => filter.field)?.length
    return count ? `Filter (${count})` : "Filter"
  }
</script>

<ActionButton icon="Filter" quiet {disabled} on:click={drawer.show} {selected}>
  {text}
</ActionButton>

<Drawer
  bind:this={drawer}
  title="Filtering"
  on:drawerHide
  on:drawerShow
  forceModal
>
  <Button
    cta
    slot="buttons"
    on:click={() => {
      dispatch("change", tempValue)
      drawer.hide()
    }}
  >
    Save
  </Button>
  <DrawerContent slot="body">
    <FilterBuilder
      {filters}
      {schemaFields}
      datasource={{ type: "table", tableId }}
      on:change={e => (tempValue = e.detail)}
      {bindings}
    />
  </DrawerContent>
</Drawer>
